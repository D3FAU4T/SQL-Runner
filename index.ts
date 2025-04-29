import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const isDebug = process.argv.includes('--debug');
const isVerbose = process.argv.includes('--verbose');

let db: Database | null = null;
const databasesDir = "./databases";
const defaultDbPath = join(databasesDir, "Runner.db");

if (!existsSync(databasesDir)) mkdirSync(databasesDir);

const useDatabase = (databaseName: string) => {
    const dbPath = join(databasesDir, `${databaseName}.db`);
    if (!existsSync(dbPath)) throw new Error(`Database "${databaseName}" does not exist.`);

    db = new Database(dbPath);
    if (isDebug || isVerbose) console.log(`Switched to database: ${databaseName}`);
};

db = new Database(defaultDbPath);

const rawSQL = await Bun.file("runner.sql").text();

const cleanedSQL = rawSQL
    .replace(/(--|#).*$/gm, "") // Remove comments
    .replace(/\r\n|\n/g, " ") // Replace newlines with spaces
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .replace(/,\s*\)/g, ")") // Remove trailing comma before ')'
    .trim();

const queries: string[] = [];
let currentQuery = "";
let insideBlock = false;

for (let i = 0; i < cleanedSQL.length; i++) {
    currentQuery += cleanedSQL[i];

    if (!insideBlock) {
        if (
            currentQuery.trimStart().toUpperCase().startsWith("DECLARE")
            || currentQuery.trimStart().toUpperCase().startsWith("BEGIN")
        ) insideBlock = true;
    }

    if (cleanedSQL[i] === ";") {
        if (insideBlock) {
            // Peek backwards to see if the previous non-space characters are 'END;'
            const check = currentQuery.trim().toUpperCase();
            if (check.endsWith("END;")) {
                queries.push(currentQuery.trim());
                currentQuery = "";
                insideBlock = false;
            }
        }
        
        // Else: still inside block, do nothing yet
        else {
            queries.push(currentQuery.trim());
            currentQuery = "";
        }
    }
}

// Just in case any leftover
if (currentQuery.trim().length > 0)
    queries.push(currentQuery.trim());

if (isDebug) console.log("Queries to execute:", queries);

let failedQuery = '';

try {
    for (const query of queries) {
        failedQuery = query;
        const normalizedQuery = query.toUpperCase();

        if (normalizedQuery.startsWith("CREATE DATABASE")) {
            const match = query.match(/CREATE DATABASE (IF NOT EXISTS )?(\w+);?/i);
            if (match) {
                const [, ifNotExists, dbName] = match;
                const dbPath = join(databasesDir, `${dbName}.db`);
                if (existsSync(dbPath)) {
                    if (!ifNotExists)
                        throw new Error(`Database "${dbName}" already exists.`);
                }
                
                else {
                    new Database(dbPath).close();
                    if (isDebug || isVerbose) console.log(`Database "${dbName}" created.`);
                }
            }
        }

        else if (normalizedQuery.startsWith("DROP DATABASE")) {
            const match = query.match(/DROP DATABASE (IF EXISTS )?(\w+);?/i);
            if (match) {
                const [, ifExists, dbName] = match;
                const dbPath = join(databasesDir, `${dbName}.db`);
                if (existsSync(dbPath)) {
                    if (db && dbPath === db.filename) {
                        db.close();
                        db = null;
                    }
                    const tempDb = new Database(dbPath);
                    tempDb.close();
                    rmSync(dbPath);
                    if (isDebug || isVerbose) console.log(`Database "${dbName}" dropped.`);
                }
                
                else if (!ifExists) throw new Error(`Database "${dbName}" does not exist.`);
            }
        }

        else if (normalizedQuery.startsWith("USE")) {
            const match = query.match(/USE (\w+);?/i);
            if (match) {
                const [, dbName] = match;
                useDatabase(dbName ?? "Runner");
            }
        }

        else if (normalizedQuery.startsWith("DESC")) {
            const match = query.match(/DESC (\w+);?/i);
            if (match) {
                const [, tableName] = match;
                if (!db) throw new Error("No database selected.");
                const transaction = db.query(`PRAGMA table_info(${tableName});`).all();
                if (transaction.length > 0) console.table(transaction);
            }
        }

        else if (normalizedQuery.startsWith("SHOW TABLES")) {
            if (!db) throw new Error("No database selected.");
            const transaction = db.query("SELECT tbl_name FROM sqlite_master WHERE type = 'table';").all();
            if (transaction.length > 0) console.table(transaction);
        }

        else if (/DECLARE.+BEGIN.+END/i.test(normalizedQuery)) {
            if (!db) throw new Error("No database selected.");
            await runOracleEmulation(query, db);
        }

        else {
            if (!db) throw new Error("No database selected.");
            const transaction = db.query(query + ";").all();
            if (transaction.length > 0) console.table(transaction);
        }
    }
} catch (e) {
    const err = e as Error;
    console.log(`\x1b[31m${err.name}\x1b[0m`, err.message);
    console.error(failedQuery);
}

async function runOracleEmulation(sqlBlock: string, db: Database) {
    const vars: Record<string, any> = {};
    const { declare, begin } = splitIntoDeclareAndBegin(sqlBlock);

    if (declare) parseAndAssignVars(declare, vars);
    if (begin) await executeBeginBlock(begin, vars, db);
}

function splitIntoDeclareAndBegin(sql: string) {
    const declareMatch = sql.match(/DECLARE([\s\S]*?)BEGIN/i);
    const beginMatch = sql.match(/BEGIN([\s\S]*)END/i);

    return {
        declare: declareMatch ? declareMatch[1]?.trim() : null,
        begin: beginMatch ? beginMatch[1]?.trim() : null,
    };
}

function parseAndAssignVars(declareBlock: string, vars: Record<string, any>) {
    const lines = declareBlock.split(/;/).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        const match = line.match(/(\w+)\s+\w+\s*(:=\s*(.+))?/i);
        if (match) {
            const [, varName, , value] = match;
            if (value && varName)
                vars[varName] = evaluateExpression(value.trim(), vars);
            
            else if (varName)
                vars[varName] = null;
        }
    }
}

async function executeBeginBlock(beginBlock: string, vars: Record<string, any>, db: Database) {
    const lines = beginBlock.split(/;/).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (line.includes(":=")) {
            const [left, right] = line.split(":=").map(part => part.trim());
            if (left) 
                vars[left] = evaluateExpression(right ?? "", vars);
        } 
        
        else if (/DBMS_OUTPUT\.PUT_LINE/i.test(line)) {
            const contentMatch = line.match(/DBMS_OUTPUT\.PUT_LINE\s*\((.+)\)/i);

            if (contentMatch) {
                let outputContent = contentMatch[1] ?? '';
        
                // Replace variable references in the output string
                outputContent = outputContent.replace(/\|\|/g, "+"); // Oracle uses || for string concat
        
                // Replace variables inside the string
                for (const [key, value] of Object.entries(vars)) {
                    const regex = new RegExp(`\\b${key}\\b`, "g");
                    outputContent = outputContent.replace(regex, JSON.stringify(value));
                }

                // Evaluate the final output
                const finalOutput = eval(outputContent);
                console.log(finalOutput);
            }
        }

        else {
            const sql = replaceVarsInSQL(line, vars);
            const prepared = db.query(sql);
            try {
                const rows = prepared.all();
                if (rows.length > 0) console.table(rows);
            }
            
            catch { prepared.run(); }
        }
    }
}

function evaluateExpression(expr: string, vars: Record<string, any>): any {
    const withVars = expr.replace(/\b(\w+)\b/g, (match) => {
        if (vars.hasOwnProperty(match))
            return JSON.stringify(vars[match]);

        return match;
    });

    try { return eval(withVars); }
    catch { return withVars; }
}

function replaceVarsInSQL(sql: string, vars: Record<string, any>): string {
    return sql.replace(/\b(\w+)\b/g, (match) => {
        if (vars.hasOwnProperty(match)) {
            const value = vars[match];
            if (typeof value === "string")
                return `'${value}'`;

            else return String(value);
        }
        
        return match;
    });
}
