# Storage Service（存储服务）

**职责范围**：存储提供商抽象层（R2 绑定 / S3 协议）、对象操作（HEAD/GET/PUT/DELETE/COPY/List）、分片上传、预签名 URL、连通性测试、多 Provider 切换。

## 目录结构

```
services/storage/
├── providers.ts   // Provider 工厂（getProvider/getProviderForMount）
├── r2.ts          // R2BindingProvider（基于 env.R2 绑定）
├── s3.ts          // S3Provider（R2 S3 API / AWS S3 / Oracle）
└── types.ts       // StorageProviderInterface 抽象接口
```

## Provider 选择

- `type=r2` 且无 endpoint → `R2BindingProvider`（本地/生产 R2 绑定）
- 其余 → `S3Provider`（S3 协议客户端）

## 依赖

- `db`（ProviderRepo/MountRepo）、`utils/crypto.ts`（decryptSecret）
