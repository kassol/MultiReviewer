import { findOrdersByCustomer } from "./db.js";
import { clampPage, pageSlice } from "./pagination.js";

const PER_PAGE = 20;

// 这一层自己看不出问题:两个下游各自的行为决定它有没有缺陷。
export async function listOrders(req) {
  const orders = await findOrdersByCustomer(req.query.customerId, req.query.status);
  const page = clampPage(Number(req.query.page), orders.length, PER_PAGE);
  return pageSlice(orders, page, PER_PAGE);
}
