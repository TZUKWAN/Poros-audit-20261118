/**
 * 认证与授权（PRD §3.4：权限 = 组织策略 ∩ 用户身份 ∩ 项目授权 ∩ Agent 预授权 ∩ 本次任务同意）。
 * 服务端强制：任何跨作用域读取都过这里，前端隐藏不算授权。
 */
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from './db.js';
import { env } from './env.js';
import type { Role } from '@prisma/client';

export interface Principal {
	userId: string;
	organizationId: string;
	role: Role;
	email: string;
}

export function hashPassword(plain: string): string {
	return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hashed: string): boolean {
	return bcrypt.compareSync(plain, hashed);
}

export function signSession(p: Principal): string {
	return jwt.sign(p, env.jwtSecret(), { expiresIn: '12h' });
}

export function verifySession(token: string): Principal | null {
	try {
		const decoded = jwt.verify(token, env.jwtSecret());
		if (typeof decoded !== 'object' || decoded === null) return null;
		const d = decoded as Record<string, unknown>;
		if (typeof d.userId !== 'string' || typeof d.organizationId !== 'string' || typeof d.role !== 'string' || typeof d.email !== 'string') return null;
		return { userId: d.userId, organizationId: d.organizationId, role: d.role as Role, email: d.email };
	} catch {
		return null;
	}
}

declare module 'fastify' {
	interface FastifyRequest {
		principal: Principal | null;
	}
}

export async function authMiddleware(req: FastifyRequest): Promise<void> {
	req.principal = null;
	const header = req.headers.authorization || '';
	let token = header.startsWith('Bearer ') ? header.slice(7) : '';
	// 下载链接等 <a href> 场景：允许 GET 请求携带 ?token=（仅当无 Authorization 头时）
	if (!token && req.method === 'GET') {
		const q = (req.query as Record<string, unknown>)?.token;
		if (typeof q === 'string' && q) token = q;
	}
	if (!token) return;
	const p = verifySession(token);
	if (!p) return;
	// 会话签发后成员可能已被移除：每次请求核对成员资格（拒绝已被踢出的用户）。
	const member = await getDb().membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId: p.userId } } });
	if (!member) return;
	req.principal = { ...p, role: member.role };
}

export function requirePrincipal(req: FastifyRequest, reply: FastifyReply): Principal | null {
	if (!req.principal) { reply.code(401).send({ ok: false, error: '未认证' }); return null; }
	return req.principal;
}

export function requireRole(min: Role[], p: Principal, reply: FastifyReply): boolean {
	const order: Record<Role, number> = { EMPLOYEE: 1, REVIEWER: 2, BUILDER: 3, ADMIN: 4 };
	const okRole = min.some((r) => order[p.role] >= order[r]);
	if (!okRole) reply.code(403).send({ ok: false, error: `需要角色 ${min.join('/')}，当前 ${p.role}` });
	return okRole;
}

/** 项目授权检查：项目必须属于本组织且用户在成员表内（ADMIN 例外）。 */
export async function assertProjectAccess(organizationId: string, projectId: string, userId: string, role: Role): Promise<boolean> {
	const db = getDb();
	const project = await db.project.findFirst({ where: { id: projectId, organizationId } });
	if (!project) return false;
	if (role === 'ADMIN') return true;
	const m = await db.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
	return !!m;
}
