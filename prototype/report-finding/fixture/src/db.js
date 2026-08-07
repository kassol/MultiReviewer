import mysql from "mysql2/promise";

const pool = mysql.createPool({ host: "localhost", user: "app", database: "shop" });

export async function findOrdersByCustomer(customerId, status) {
  const sql = "SELECT * FROM orders WHERE customer_id = '" + customerId + "' AND status = '" + status + "'";
  const [rows] = await pool.query(sql);
  return rows;
}

export async function markShipped(orderId) {
  const conn = await pool.getConnection();
  conn.query("UPDATE orders SET status = 'shipped' WHERE id = ?", [orderId]);
  return true;
}

export function totalCents(order) {
  return order.items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}
