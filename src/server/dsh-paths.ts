/**
 * SceneFlow 路径决议——隔离 by construction（ISO-01 的软件级证据核心）。
 *
 * 安全性质：一切数据/配置/运行时路径只从 SCENEFLOW_HOME 派生；
 * **永不**回退到 os.homedir()、process.env.HOME、USERPROFILE 或宿主 DSH_HOME。
 * 缺失 SCENEFLOW_HOME 时直接抛错——宁可拒绝启动也不碰任何默认目录。
 *
 * 本模块不得 import 任何 pi-* / DSH 宿主相关包；它是纯路径逻辑，可独立审计。
 */
import path from 'node:path';

export class SceneFlowHomeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SceneFlowHomeError';
	}
}

export function resolveSceneFlowHome(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.SCENEFLOW_HOME;
	if (typeof home !== 'string' || home.trim() === '') {
		throw new SceneFlowHomeError('SCENEFLOW_HOME 未设置：SceneFlow 拒绝回退到任何默认目录（操作系统默认目录与任何外部数据目录一律不用）');
	}
	const resolved = path.resolve(home);
	const forbidden = [
		{ re: /^([A-Za-z]:[\\/])?Users[\\/][^\\/]+[\\/]\.dsh$/i, label: '宿主用户 .dsh 目录' },
		{ re: /^[\\/]root[\\/]\.dsh$/, label: 'root .dsh 目录' },
		{ re: /^[\\/]home[\\/](?!sceneflow)[^\\/]+[\\/]\.dsh$/, label: '其他用户 .dsh 目录' }
	];
	const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
	for (const { re, label } of forbidden) {
		if (re.test(normalized)) throw new SceneFlowHomeError(`SCENEFLOW_HOME 指向${label}，已拒绝：${resolved}`);
	}
	return resolved;
}

export interface SceneFlowPaths {
	sceneFlowHome: string;
	dshRuntimeDir: string;   // 容器/子进程内 DSH 的专属数据根（容器内为 /home/sceneflow/.dsh）
	configDir: string;
	dataDir: string;
	cacheDir: string;
	runsDir: string;         // 运行证据/轨迹
	secretsRefDir: string;   // 仅存放 SecretReference 名称，永不存明文
}

export function resolveSceneFlowPaths(env: NodeJS.ProcessEnv = process.env): SceneFlowPaths {
	const sceneFlowHome = resolveSceneFlowHome(env);
	return {
		sceneFlowHome,
		dshRuntimeDir: path.join(sceneFlowHome, 'dsh-runtime'),
		configDir: path.join(sceneFlowHome, 'config'),
		dataDir: path.join(sceneFlowHome, 'data'),
		cacheDir: path.join(sceneFlowHome, 'cache'),
		runsDir: path.join(sceneFlowHome, 'runs'),
		secretsRefDir: path.join(sceneFlowHome, 'secrets-ref')
	};
}
