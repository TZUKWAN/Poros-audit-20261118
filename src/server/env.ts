/**
 * 环境解析：全部配置显式来自环境变量；缺失即抛错（与 dsh-paths.ts 同一隔离哲学——
 * 不存在"悄悄用默认值连到某个外部系统"的路径）。
 */
function required(name: string): string {
	const v = process.env[name];
	if (typeof v !== 'string' || v.trim() === '') throw new Error(`环境变量 ${name} 未设置：SceneFlow 拒绝以默认/隐式配置启动`);
	return v;
}

export const env = {
	databaseUrl: () => process.env.DATABASE_URL || 'postgresql://sceneflow:sceneflow@127.0.0.1:55432/sceneflow?schema=public',
	jwtSecret: () => process.env.JWT_SECRET || 'dev-only-secret-change-me',
	s3: {
		endpoint: () => process.env.S3_ENDPOINT || 'http://127.0.0.1:59000',
		region: () => process.env.S3_REGION || 'us-east-1',
		bucket: () => process.env.S3_BUCKET || 'sceneflow-artifacts',
		accessKey: () => process.env.S3_ACCESS_KEY || 'sceneflow-minio',
		secretKey: () => process.env.S3_SECRET_KEY || 'sceneflow-minio'
	},
	/** 模型网关：mock（默认，UI 如实标注"未配置真实服务"）| deepseek（需真实密钥） */
	modelGateway: () => process.env.MODEL_GATEWAY || 'mock',
	deepseekApiKey: () => process.env.SCENEFLOW_DEEPSEEK_API_KEY || '',
	kdocsConfigured: () => process.env.KDOCS_CONFIGURED === 'true'
};

export { required };
