import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const { values } = parseArgs({
  options: {
    organization: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", default: "EMPLOYEE" },
  },
});
const { organization, email, role } = values;
if (
  !organization ||
  !/^[A-Za-z0-9_-]{1,100}$/.test(organization) ||
  !email ||
  !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
  email.length > 254 ||
  email.endsWith(".test") ||
  !["ADMIN", "BUILDER", "REVIEWER", "EMPLOYEE"].includes(role)
)
  throw new Error("Provide a valid --organization, --email and --role");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be explicit");
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 80) throw new Error("Password exceeds 72 bytes");
}
const password = input.replace(/\r?\n$/, "");
if (password.length < 16 || Buffer.byteLength(password) > 72)
  throw new Error("Provide a 16–72 byte strong password on stdin");
const passwordHash = await bcrypt.hash(password, 12);

const db = new PrismaClient();
try {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`CREATE TABLE IF NOT EXISTS user_credentials (
      email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await tx.organization.upsert({
      where: { id: organization },
      update: {},
      create: { id: organization, name: values.name || organization },
    });
    const inserted = await tx.$executeRaw`INSERT INTO user_credentials (email,password_hash)
      VALUES (${email},${passwordHash}) ON CONFLICT (email) DO NOTHING`;
    if (inserted !== 1)
      throw new Error("Account already exists; password and roles were preserved");
    await tx.membership.create({ data: { organizationId: organization, userId: email, role } });
  });
  console.log("Created member " + email + " in " + organization + " (" + role + ")");
} finally {
  await db.$disconnect();
}
