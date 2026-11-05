import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_PATH = "data/sample.db";

const CUSTOMER_COUNT = 200;
const PRODUCT_COUNT = 60;
const ORDER_COUNT = 2_000;

const CATEGORIES = ["Books", "Electronics", "Garden", "Kitchen", "Sports", "Toys"];
const COUNTRIES = ["Argentina", "Brazil", "Canada", "Germany", "Japan", "Portugal"];
// Repeating "delivered" makes it the most common status.
const STATUSES = ["delivered", "delivered", "delivered", "shipped", "cancelled"];

const SCHEMA = `
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_date TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL,
    PRIMARY KEY (order_id, product_id)
  );
`;

/** Mulberry32, a small seeded generator, so every run produces the same data. */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSampleDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });

  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const random = createRandom(42);
  const randomInt = (min: number, max: number) =>
    min + Math.floor(random() * (max - min + 1));
  const pick = (items: string[]) => items[randomInt(0, items.length - 1)] as string;
  const paddedInt = (min: number, max: number) =>
    String(randomInt(min, max)).padStart(2, "0");

  const insertCustomer = db.prepare("INSERT INTO customers VALUES (?, ?, ?)");
  const insertProduct = db.prepare("INSERT INTO products VALUES (?, ?, ?, ?)");
  const insertOrder = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?)");
  // Random picks can repeat a product within an order, so duplicates are skipped.
  const insertItem = db.prepare("INSERT OR IGNORE INTO order_items VALUES (?, ?, ?)");

  db.exec("BEGIN");

  for (let id = 1; id <= CUSTOMER_COUNT; id++) {
    insertCustomer.run(id, `Customer ${id}`, pick(COUNTRIES));
  }

  for (let id = 1; id <= PRODUCT_COUNT; id++) {
    const price = randomInt(500, 25_000) / 100;
    insertProduct.run(id, `Product ${id}`, pick(CATEGORIES), price);
  }

  for (let id = 1; id <= ORDER_COUNT; id++) {
    const date = `${randomInt(2024, 2025)}-${paddedInt(1, 12)}-${paddedInt(1, 28)}`;
    insertOrder.run(id, randomInt(1, CUSTOMER_COUNT), date, pick(STATUSES));

    for (let itemCount = randomInt(1, 4); itemCount > 0; itemCount--) {
      insertItem.run(id, randomInt(1, PRODUCT_COUNT), randomInt(1, 3));
    }
  }

  db.exec("COMMIT");
  db.close();
}

if (import.meta.main) {
  const path = process.argv[2] ?? DEFAULT_PATH;
  createSampleDb(path);
  console.log(`Sample database created: ${path}`);
}
