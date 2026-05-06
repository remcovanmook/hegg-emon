import sqlite3
conn = sqlite3.connect(':memory:')
try:
    conn.execute('BEGIN')
    print("BEGIN 1 works")
    conn.execute('CREATE TABLE foo (id INT)')
    conn.execute('BEGIN')
    print("BEGIN 2 works")
except Exception as e:
    print("Error:", e)
