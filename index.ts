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

const queries = (await Bun.file("runner.sql").text())
    .split(";")
    .map(query =>
        query
            .replace(/--.*$/gm, "") // Remove comments (both inline and full-line)
            .replace(/\r\n|\n/g, " ") // Replace newlines with spaces
            .replace(/\s+/g, " ") // Collapse multiple spaces
            .replace(/,\s*\)$/, ")") // Remove trailing comma before ')'
            .trim() // Remove leading and trailing whitespace
    )
    .filter(query => query.length > 0); // Filter out empty queries

if (isDebug) console.log("Queries to execute:", queries);

try {
    for (const query of queries) {
        const normalizedQuery = query.toUpperCase();

        if (normalizedQuery.startsWith("CREATE DATABASE")) {
            const match = query.match(/CREATE DATABASE (IF NOT EXISTS )?(\w+);?/i);
            if (match) {
                const [, ifNotExists, dbName] = match;
                const dbPath = join(databasesDir, `${dbName}.db`);
                if (existsSync(dbPath)) {
                    if (!ifNotExists) throw new Error(`Database "${dbName}" already exists.`);
                } else {
                    new Database(dbPath).close();
                    if (isDebug || isVerbose) console.log(`Database "${dbName}" created.`);
                }
            }
        } else if (normalizedQuery.startsWith("DROP DATABASE")) {
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
                } else if (!ifExists) throw new Error(`Database "${dbName}" does not exist.`);
            }
        } else if (normalizedQuery.startsWith("USE")) {
            const match = query.match(/USE (\w+);?/i);
            if (match) {
                const [, dbName] = match;
                useDatabase(dbName ?? "Runner");
            }
        } else {
            if (!db) throw new Error("No database selected.");

            const transaction = db.query(query + ";").all();

            if (transaction.length > 0) console.table(transaction);
        }
    }
} catch (e) {
    const err = e as Error;
    console.log(`\x1b[31m${err.name}\x1b[0m`, err.message);
}