const sample =
`DROP TABLE IF EXISTS students;

CREATE TABLE students (
    ID   INT         PRIMARY KEY,
    Name VARCHAR(20),
    Age  INT,
);

INSERT INTO students VALUES
(1, 'Alice', 20),
(2, 'Bob', 22),
(3, 'Charlie', 23),
(4, 'David', 21);

SELECT * FROM students;`

await Bun.write("./runner.sql", sample);