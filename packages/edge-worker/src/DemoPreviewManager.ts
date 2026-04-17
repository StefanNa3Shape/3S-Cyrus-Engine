import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface DemoSession {
	issueId: string;
	token: string;
	childProcess: ChildProcess;
	port: number;
	createdAt: number;
	expiresAt: number;
	worktreePath: string;
}

const DEMO_TTL_MS = 10 * 60 * 1000;
const TOKEN_LENGTH = 20;

export class DemoPreviewManager {
	private sessions = new Map<string, DemoSession>();
	private logger: ILogger;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "DemoPreviewManager" });
	}

	registerRoutes(app: FastifyInstance): void {
		app.post(
			"/demo/start",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const body = request.body as {
					issueId?: string;
					worktreePath?: string;
					startCommand?: string;
				} | null;
				const issueId = body?.issueId;
				const worktreePath = body?.worktreePath;
				const startCommand = body?.startCommand;

				if (!issueId || !worktreePath) {
					return reply
						.status(400)
						.send({ error: "issueId and worktreePath required" });
				}
				if (!existsSync(worktreePath)) {
					return reply.status(404).send({
						error: `Worktree not found: ${worktreePath}`,
					});
				}

				try {
					const session = await this.startDemo(
						issueId,
						worktreePath,
						startCommand,
					);
					const baseUrl =
						process.env.CYRUS_BASE_URL ||
						`http://localhost:${process.env.PORT || 3456}`;
					return reply.send({
						url: `${baseUrl}/demo/${session.issueId}/${session.token}`,
						localUrl: `/demo/${session.issueId}/${session.token}`,
						expiresInSeconds: DEMO_TTL_MS / 1000,
						expiresAt: new Date(session.expiresAt).toISOString(),
					});
				} catch (err) {
					return reply.status(500).send({
						error: `Failed to start demo: ${(err as Error).message}`,
					});
				}
			},
		);

		app.get(
			"/demo/status",
			async (_request: FastifyRequest, reply: FastifyReply) => {
				const sessions = Array.from(this.sessions.values()).map((s) => ({
					issueId: s.issueId,
					port: s.port,
					createdAt: new Date(s.createdAt).toISOString(),
					expiresAt: new Date(s.expiresAt).toISOString(),
					remainingSeconds: Math.max(
						0,
						Math.floor((s.expiresAt - Date.now()) / 1000),
					),
				}));
				return reply.send({
					activeSessions: sessions.length,
					sessions,
				});
			},
		);

		app.get(
			"/demo/:issueId/:token",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { issueId, token } = request.params as {
					issueId: string;
					token: string;
				};
				return this.proxyToDemo(issueId, token, request, reply);
			},
		);

		app.get(
			"/demo/:issueId/:token/*",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { issueId, token } = request.params as {
					issueId: string;
					token: string;
				};
				return this.proxyToDemo(issueId, token, request, reply);
			},
		);

		this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30_000);

		this.logger.info("✅ Demo preview routes registered");
		this.logger.info("   POST /demo/start");
		this.logger.info("   GET  /demo/:issueId/:token");
		this.logger.info("   GET  /demo/status");
	}

	private async startDemo(
		issueId: string,
		worktreePath: string,
		startCommand?: string,
	): Promise<DemoSession> {
		if (this.sessions.has(issueId)) {
			await this.stopDemo(issueId);
		}

		const token = randomBytes(TOKEN_LENGTH)
			.toString("hex")
			.slice(0, TOKEN_LENGTH);
		const port = 9000 + Math.floor(Math.random() * 1000);
		const cmd = startCommand || this.detectStartCommand(worktreePath);

		this.logger.info(`Starting demo for ${issueId} on port ${port}: ${cmd}`);

		const childProcess = spawn("sh", ["-c", cmd], {
			cwd: worktreePath,
			env: {
				...process.env,
				PORT: String(port),
				NODE_ENV: "development",
			},
			stdio: "pipe",
		});

		childProcess.stdout?.on("data", (data: Buffer) => {
			this.logger.info(`[demo:${issueId}] ${data.toString().trim()}`);
		});
		childProcess.stderr?.on("data", (data: Buffer) => {
			this.logger.info(`[demo:${issueId}:err] ${data.toString().trim()}`);
		});
		childProcess.on("exit", (code) => {
			this.logger.info(`[demo:${issueId}] Process exited with code ${code}`);
			this.sessions.delete(issueId);
		});

		const session: DemoSession = {
			issueId,
			token,
			childProcess,
			port,
			createdAt: Date.now(),
			expiresAt: Date.now() + DEMO_TTL_MS,
			worktreePath,
		};
		this.sessions.set(issueId, session);

		// Wait for app to start
		await new Promise((resolve) => setTimeout(resolve, 5000));
		return session;
	}

	private async proxyToDemo(
		issueId: string,
		token: string,
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		const session = this.sessions.get(issueId);
		if (!session) {
			return reply.status(404).send({ error: "Demo not found or expired" });
		}
		if (session.token !== token) {
			return reply.status(403).send({ error: "Invalid token" });
		}
		if (Date.now() > session.expiresAt) {
			await this.stopDemo(issueId);
			return reply.status(410).send({ error: "Demo expired" });
		}

		const subPath = request.url.replace(`/demo/${issueId}/${token}`, "") || "/";
		const targetUrl = `http://localhost:${session.port}${subPath}`;

		try {
			const response = await fetch(targetUrl, {
				method: request.method as string,
				headers: { host: `localhost:${session.port}` },
			});
			const contentType = response.headers.get("content-type") || "text/html";
			const body = Buffer.from(await response.arrayBuffer());
			return reply
				.status(response.status)
				.header("content-type", contentType)
				.send(body);
		} catch {
			return reply.status(502).send({
				error: "Demo app not responding. It may still be starting.",
			});
		}
	}

	private detectStartCommand(worktreePath: string): string {
		const frontendPkg = join(worktreePath, "frontend", "package.json");
		if (existsSync(frontendPkg)) {
			return "cd frontend && npm run dev";
		}
		const rootPkg = join(worktreePath, "package.json");
		if (existsSync(rootPkg)) {
			try {
				const pkg = JSON.parse(readFileSync(rootPkg, "utf-8"));
				if (pkg.scripts?.dev) return "npm run dev";
				if (pkg.scripts?.start) return "npm start";
			} catch {
				/* ignore */
			}
		}
		return "npm start";
	}

	private async stopDemo(issueId: string): Promise<void> {
		const session = this.sessions.get(issueId);
		if (!session) return;
		this.logger.info(`Stopping demo for ${issueId}`);
		session.childProcess.kill("SIGTERM");
		setTimeout(() => {
			try {
				session.childProcess.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, 5000);
		this.sessions.delete(issueId);
	}

	private cleanupExpired(): void {
		for (const [issueId, session] of this.sessions) {
			if (Date.now() > session.expiresAt) {
				this.logger.info(`Demo expired for ${issueId}`);
				this.stopDemo(issueId);
			}
		}
	}

	async shutdown(): Promise<void> {
		if (this.cleanupInterval) clearInterval(this.cleanupInterval);
		for (const issueId of this.sessions.keys()) {
			await this.stopDemo(issueId);
		}
	}
}
