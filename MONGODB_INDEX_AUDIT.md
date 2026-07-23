# Auditoria de Índices MongoDB

Data: 2026-07-23

Escopo: modelos Mongoose, rotas, middlewares, worker React/Vite, utilitários de publicação, briefing, runtime store, quota, Stripe e scripts operacionais do backend Fluid. Não houve conexão com banco de produção; "índice atual" abaixo significa o índice declarado no schema antes desta auditoria quando identificável. Use `node scripts/syncMongoIndexes.js` para comparar contra os índices reais do ambiente.

## Consultas Auditadas

| Fluxo | Arquivo | Filtro | Sort / paginação | Campos | Índice atual antes | Índice recomendado |
| --- | --- | --- | --- | --- | --- | --- |
| Autenticação pública | `middleware/authMiddleware.js`, `server.js`, `routes/authRoutes.js` | `Session.findOne/exists({ jti, userId, revokedAt:null, expiresAt:{$gt:now} })` | nenhum | sessão completa ou exists | `jti` unique; `{ userId, revokedAt, expiresAt }` | manter `jti` unique; `{ userId, revokedAt, createdAt:-1, expiresAt }` para listagem/revogação |
| Sessões do usuário | `routes/authRoutes.js` | `Session.find({ userId, revokedAt:null, expiresAt:{$gt:now} })` | `createdAt:-1` | sessão serializada | não cobria sort | `{ userId, revokedAt, createdAt:-1, expiresAt }` |
| Revogação sessão | `routes/authRoutes.js` | `Session.updateOne({ _id, userId, revokedAt:null })`; `updateMany({ userId, revokedAt:null })` | nenhum | n/a | `_id`; `{ userId, revokedAt, expiresAt }` | `{ userId, revokedAt, createdAt:-1, expiresAt }` |
| Admin auth | `routes/adminAuthRoutes.js`, `middleware/adminAuth.js` | `AdminUser.findOne({ email })`, `findById`, `AdminSession.findOne({ jti, adminUserId, revokedAt:null, expiresAt:{$gt:now} })` | nenhum | auth fields | `email` unique; `jti` unique; `{ adminUserId, revokedAt, expiresAt }` | manter uniques; `{ adminUserId, revokedAt, createdAt:-1, expiresAt }` |
| Admin audit idempotente | `middleware/adminAuth.js` | `AdminAuditLog.findOne({ idempotencyKey, result:{$in:[success,pending]} })` | `timestamp:-1` | audit doc | `{ idempotencyKey, result }` unique partial | manter; sort opera sobre no máximo dois resultados por chave |
| Usuários locais/OAuth | `routes/authRoutes.js` | `User.findOne({ email/googleId/githubId })`, `exists({'profile.username':...})`, `findById` | nenhum | usuário ou auth fields | uniques existentes | manter uniques de `email`, `googleId`, `githubId`, `profile.username` |
| Usuário deletado | `routes/authRoutes.js` | `User.exists({ deletedAt:{$ne:null}, deletedIdentityHashes:{$in:hashes} })` | nenhum | exists | `{ deletedAt, deletedIdentityHashes }` | manter composto |
| Projetos do usuário | `routes/projectRoutes.js`, `utils/projectNaming.js`, `authRoutes.js`, `billingRoutes.js` | `Project.find/count({ userId, ... })` | `createdAt:-1` ou nenhum | projeto, `_id`, `name title` | só partial `{ userId, creationIdempotencyKey }` | `{ userId, createdAt:-1, _id:-1 }`; `{ userId, isPublished }` |
| Projeto por dono | múltiplas rotas de projeto/chat | `Project.findOne({ _id, userId })` | nenhum | variado | `_id` | `_id` basta; `userId` é filtro de isolamento pós-lookup |
| Idempotência de criação | `routes/projectRoutes.js` | `Project.findOne({ userId, creationIdempotencyKey })` | nenhum | projeto | unique partial existente | manter |
| Público por slug | `server.js` | `Project.findOne({ slug, isPublished:true })` | nenhum | projeto | `slug` unique sparse | manter; `isPublished` é filtro residual de 1 doc |
| Admin projetos | `routes/adminRoutes.js` | `Project.find()` | `updatedAt:-1, createdAt:-1`, `limit<=100` | projeto | nenhum | `{ updatedAt:-1, createdAt:-1, _id:-1 }` |
| Builds latest por projeto/status | `server.js`, `projectRoutes.js`, `adminRoutes.js`, `utils/projectSnapshot.js`, `utils/projectFiles.js` | `ProjectBuild.findOne({ projectId, status })` | `createdAt/updatedAt/_id` desc | build fields | `{ projectId, status, createdAt:-1 }` | `{ projectId, status, createdAt:-1, updatedAt:-1, _id:-1 }` |
| Builds por projeto | `adminRoutes.js` | `ProjectBuild.find({ projectId })` | `createdAt:-1, updatedAt:-1` | builds | `projectId` simples | `{ projectId, createdAt:-1, updatedAt:-1, _id:-1 }` |
| Build artifact/publicação por URL | `server.js`, `utils/projectPublication.js` | `ProjectBuild.find({ projectId, $or:[url equality, url suffix regex] })` | `updatedAt:-1, createdAt:-1` | URL/artifact fields | `projectId` simples | `{ projectId, updatedAt:-1, createdAt:-1, _id:-1 }`; modelar `buildKey` canônico no futuro |
| BuildJob fila | `workers/reactViteBuildWorker.js` | `findOneAndUpdate({ type:'react_vite', $or:[queued, stale lease] })` | `queuedAt:1,_id:1` | job | `{ status, queuedAt }`; `leaseUntil` | `{ status:1, queuedAt:1, _id:1 }`; manter `leaseUntil` |
| BuildJob por build | rotas/status/publicação | `{ projectBuildId }` ou `{ projectId, projectBuildId }` | `createdAt:-1` | status | `{ projectBuildId, createdAt:-1 }` | `{ projectBuildId, createdAt:-1, _id:-1 }`; `{ projectId, projectBuildId }` |
| Chat histórico de projeto | `routes/chatRoutes.js`, `projectRoutes.js`, `adminRoutes.js` | `ProjectMessage.find({ projectId, role:{$in:[...]?} })` | `createdAt,_id` asc/desc; `limit` em chat | role/content/createdAt | `{ projectId, createdAt }`; simples `role` | `{ projectId, createdAt:1, _id:1 }`; `role` fica filtro residual de baixa seletividade |
| Chat histórico de sessão | `routes/chatRoutes.js` | `ChatMessage.find({ userId, sessionId, role:{$in:[...]} })` | `createdAt:-1,_id:-1`, `limit` | role/content/createdAt | `{ userId, sessionId, createdAt }`; simples user/session/role | `{ userId, sessionId, createdAt:1, _id:1 }` reversível |
| Briefing session lookup | `utils/briefingSessions.js` | `{ userId, conversationId, status:'active', expiresAt:{$gt:now} }` ou `{ _id, userId }` | `updatedAt:-1,_id:-1` | briefing session | simples e `{ userId, conversationId, status, updatedAt }` | `{ userId, conversationId, status, updatedAt:-1, _id:-1, expiresAt:1 }`; TTL `expiresAt` |
| Connector secrets | `projectRoutes.js`, `adminRoutes.js`, `connectorInjection.js` | `{ projectId }`, `{ projectId, userId }`, `{ projectId, userId, provider }` | nenhum | provider/secret fields | simples + unique composto | manter só `{ projectId, userId, provider }` unique |
| Change requests admin | `adminRoutes.js` | `{}`, `{ status }`, `{ projectId }`, aggregate `{ status:'pending', projectId:{$in} }` | `createdAt:-1,_id:-1`, `limit<=100` | CR + populate | simples + compostos sem `_id` | `{ createdAt:-1,_id:-1 }`, `{ status, createdAt:-1,_id:-1 }`, `{ projectId, createdAt:-1,_id:-1 }`, `{ projectId,status,createdAt:-1,_id:-1 }` |
| Runtime documents | `runtimeStore.js` | `{ projectId, collection, filter }`; filters `_id`, `ownerId`, `data.email`, safe `data.*` | `createdAt:-1`; `skip/limit<=100` | docs | compostos por project/collection | manter e adicionar `{ projectId, collection, ownerId, createdAt:-1 }` |
| Billing webhooks | `billingRoutes.js` | `StripeWebhookEvent.{create,findOne,findOneAndUpdate,updateOne}({ eventId, status? })`; `User.findOneAndUpdate({ $or:[stripe ids,_id] })` | nenhum | status / user | `eventId` unique; stripe ids simples | `eventId` unique; stripe IDs unique partial non-empty; TTL processed webhooks |
| Quotas | `utils/aiQuota.js`, `middleware/rateLimit.js` | `User.findById(...).select('plan')`; Redis rate limit keys | nenhum | plan | `_id` | Mongo não usado para rate limit persistido |

## Índices Adicionados ou Alterados no Schema

- `sessions`: `{ userId, revokedAt, createdAt:-1, expiresAt }`; TTL `{ expiresAt }`.
- `adminsessions`: `{ adminUserId, revokedAt, createdAt:-1, expiresAt }`; TTL `{ expiresAt }`.
- `briefingsessions`: `{ userId, conversationId, status, updatedAt:-1, _id:-1, expiresAt }`; TTL `{ expiresAt }`.
- `projects`: `{ userId, createdAt:-1, _id:-1 }`, `{ userId, isPublished }`, `{ updatedAt:-1, createdAt:-1, _id:-1 }`, sparse `{ briefingSessionId }`.
- `projectbuilds`: `{ projectId, status, createdAt:-1, updatedAt:-1, _id:-1 }`, `{ projectId, createdAt:-1, updatedAt:-1, _id:-1 }`, `{ projectId, updatedAt:-1, createdAt:-1, _id:-1 }`.
- `buildjobs`: `{ status, queuedAt, _id }`, `{ projectBuildId, createdAt:-1, _id:-1 }`, `{ projectId, projectBuildId }`.
- `projectmessages`: `{ projectId, createdAt, _id }`.
- `chatmessages`: `{ userId, sessionId, createdAt, _id }`.
- `projectchangerequests`: compostos por `createdAt`, `status+createdAt`, `projectId+createdAt`, `projectId+status+createdAt`.
- `runtime_documents`: `{ projectId, collection, ownerId, createdAt:-1 }`.
- `users`: unique partial non-empty para todos os IDs Stripe customer/subscription, por modo e legado.
- `stripewebhookevents`: TTL parcial em `receivedAt` para eventos `processed` por 90 dias.

## Problemas Detectados

- Regex sem prefixo utilizável: buscas de build URL com `new RegExp("${url}$")` em `distUrl`, `previewUrl`, `buildUrl`, `deployUrl`; regex ancorada no fim não usa índice B-tree de forma eficiente. Correção estrutural recomendada: persistir `buildKey`/`canonicalIndexBuildUrl` normalizado e consultar por igualdade.
- Regex prefixada: `cleanupAdminDonePublicPublish.js` usa regex `^PUBLIC_BASE_URL/p/` em `deploy.url`; é script operacional limitado e não recebeu índice dedicado.
- Paginação por `skip`: runtime store aceita `skip` com `limit<=100`; alto `skip` ainda degrada. Recomenda-se paginação por cursor (`createdAt,_id`) se coleções runtime crescerem.
- Baixa seletividade: índices simples em `status`, `role`, `active`, `result`, `ownerDeleted`, `accountDeleted` foram evitados/removidos quando havia consulta composta real melhor; alguns de admin audit/admin user permanecem como potencialmente redundantes.
- Unique ausente antes da auditoria: IDs Stripe eram apenas indexados; agora são unique parcial. `runtime_documents` com `collection='users'` + `data.email` segue não-unique porque a coleção genérica pode ter e-mails duplicados em outras collections; aplicar unique parcial para runtime users exigiria dedupe/migração específica.
- TTL não aplicável: `User.twoFactor.pendingExpiresAt` é embedded em usuário; TTL nesse campo apagaria o usuário inteiro. Deve ser limpo por rotina lógica, não TTL.

## Índices Potencialmente Redundantes no Banco Existente

O script não remove nada. Após aplicar novos índices e validar `explain`, considerar remoção manual dos antigos:

- `sessions`: `{ userId:1 }`, `{ userId, revokedAt, expiresAt }` se existirem.
- `adminsessions`: `{ adminUserId:1 }`, `{ adminUserId, revokedAt, expiresAt }` se existirem.
- `briefingsessions`: simples `userId`, `conversationId`, `status`, `expiresAt`, `projectId`; antigo `{ userId, conversationId, status, updatedAt }`.
- `projectbuilds`: simples `projectId`, `status`; antigo `{ projectId, status, createdAt:-1 }` depois de confirmar o novo composto.
- `projectmessages`: simples `projectId`, `role`; antigo `{ projectId, createdAt:1 }`.
- `chatmessages`: simples `userId`, `sessionId`, `role`; antigo `{ userId, sessionId, createdAt:1 }`.
- `connectorsecrets`: simples `projectId`, `userId`, `provider`.
- `projectchangerequests`: simples `projectId`, `userId`, `messageId`, `status`; antigos compostos sem `_id`.
- `runtime_documents`: simples `projectId`, `collection`, `ownerId`; antigo `{ projectId, ownerId, createdAt:-1 }`.
- `users`: antigos índices simples dos campos Stripe devem ser removidos manualmente após os unique partial serem criados e validados.
- `stripewebhookevents`: antigo `status` simples se existir.

## Deploy Seguro

1. Rodar validação somente leitura no ambiente alvo: `NODE_ENV=production node scripts/validateMongoIndexReadiness.js`.
2. Rodar dry-run no ambiente alvo: `NODE_ENV=production node scripts/syncMongoIndexes.js`.
3. Corrigir duplicidades antes dos unique partial de Stripe ou valores TTL incompatíveis se a validação indicar conflito.
4. Aplicar em janela controlada: `NODE_ENV=production node scripts/syncMongoIndexes.js --apply`. O script cria apenas indices ausentes compativeis; incompatibilidades continuam manuais e retornam exit code nao-zero.
5. Não rodar `syncIndexes()` nem habilitar `autoIndex` em produção. O servidor agora conecta com `autoIndex:false` em `NODE_ENV=production`.
6. Remoções de índices antigos devem ser feitas separadamente, uma a uma, depois de `explain("executionStats")` confirmar que os novos índices estão em uso.

Plano especifico para as incompatibilidades observadas no dry-run de producao: `MONGODB_INDEX_MIGRATION_PLAN.md`.
