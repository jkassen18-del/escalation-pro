# Database lookups on forms

A lookup lets an intake-form question offer records from a database you already run, so people pick the customer, site or asset instead of typing it. Example: a *Customer* question that searches your CRM as you type.

PostgreSQL and MySQL/MariaDB are supported. Lookups are **read-only**.

[Open Integrations](/integrations)

## 1. Connect the database

*Integrations → Database lookups → New* (permission `integrations.manage`):

| Field | Example |
| --- | --- |
| **Name** | `Customer CRM` |
| **Engine** | PostgreSQL or MySQL |
| **Host**, **Port**, **Database** | `db.internal`, `5432`, `crm` |
| **Username**, **Password** | An account with `SELECT` and nothing else. The password is stored encrypted |
| **Encrypt the connection** | TLS, without verifying the server certificate (managed providers use private CAs) |
| **Lookup query** | A single `SELECT` with `:search` where the typed text goes |
| **Value column** | Stored on the ticket |
| **Label column** | Shown in the picker |

**Test** runs the query with an empty search and reports how many rows came back.

### Writing the query

```sql
-- PostgreSQL
SELECT id, name || ' (' || city || ')' AS label
FROM customers
WHERE name ILIKE '%' || :search || '%'
ORDER BY name

-- MySQL
SELECT id, CONCAT(name, ' (', city, ')') AS label
FROM customers
WHERE name LIKE CONCAT('%', :search, '%')
ORDER BY name
```

with **Value column** `id` and **Label column** `label`.

`:search` is always sent as a bound parameter, never pasted into the SQL, so what someone types is data to your server and can never become SQL. It may appear more than once.

### What is refused

- More than one statement, or anything not starting with `SELECT`.
- Keywords that write or change anything (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `GRANT`…).
- A query without `:search`, or longer than 4,000 characters.

### Limits at run time

- The query runs inside a **read-only transaction**, so the server rejects a write even if the account could perform one.
- 5-second connect timeout and 5-second statement timeout.
- At most 50 rows; the typed text is cut to 200 characters.

Private and internal hosts are allowed: a company's own database is almost always on a private network.

## 2. Put it on a form

*Teams → (department) → Intake form → Add question*, type **lookup**, and choose the data source. The same works on quick-ticket templates.

People raising a ticket get a search box that queries as they type; the chosen **value** is stored on the ticket and the **label** is shown.

## Who can see what

- Anyone signed in can see that a lookup exists (its id and name), because forms name them.
- Running a lookup needs *Create tickets*.
- Host, port, database, user, query and connection errors are visible only to `integrations.manage`.

## Least-privilege account

```sql
-- PostgreSQL
CREATE ROLE infraticket_lookup LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE crm TO infraticket_lookup;
GRANT USAGE ON SCHEMA public TO infraticket_lookup;
GRANT SELECT ON customers TO infraticket_lookup;

-- MySQL
CREATE USER 'infraticket_lookup'@'%' IDENTIFIED BY '…';
GRANT SELECT ON crm.customers TO 'infraticket_lookup'@'%';
```
