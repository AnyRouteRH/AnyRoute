import { pgTable, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const networkWaitlist = pgTable("network_waitlist", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  hardware: text("hardware").notNull(),
  readiness: text("readiness").notNull(),
  region: text("region").notNull(),
  contact: text("contact"),
  paidIn: text("paid_in").notNull(),
  deleteCodeHash: text("delete_code_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("network_role", sql`${t.role} in ('host_gpu','host_cpu','relay','witness','developer')`),
  check("network_region", sql`${t.region} in ('africa','antarctica','asia','europe','north_america','oceania','south_america')`),
  check("network_paid_in", sql`${t.paidIn} in ('usdg','anyr','any')`),
  check("network_lengths", sql`char_length(${t.hardware}) <= 200 and char_length(${t.readiness}) <= 300 and char_length(${t.contact}) <= 120 and char_length(${t.deleteCodeHash}) = 64`),
]);
