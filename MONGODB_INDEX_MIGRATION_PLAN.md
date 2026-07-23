# Plano Seguro de Migracao de Indices MongoDB

Data: 2026-07-23

Base: dry-run real de producao com `equivalent: 20`, `dry-run-create: 20`, `dry-run-incompatible: 8`, sem dados Stripe duplicados e sem datas TTL incompativeis.

Este plano nao deve ser executado automaticamente pelo backend. Os comandos abaixo sao comandos manuais para janela controlada.

## Premissas

- `syncMongoIndexes.js` continua seguro por padrao: dry-run nao altera nada.
- `syncMongoIndexes.js --apply` cria apenas indices ausentes compativeis; incompatibilidades sao reportadas e mantem exit code nao-zero.
- Nenhum comando de `dropIndex`, `collMod` ou recriacao de indice e executado pelo script de sync.
- Os campos Stripe ja foram validados sem duplicidade de strings nao vazias.
- Os campos TTL ja foram validados sem valores BSON incompativeis.

## 1. `briefingsessions.expiresAt_1`

- Indice atual: `{ key: { expiresAt: 1 }, name: "expiresAt_1" }`, sem `expireAfterSeconds`.
- Indice desejado: `{ key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 }`.
- Impacto: transforma `expiresAt` em TTL absoluto; documentos com `expiresAt` no passado passam a ser elegiveis para remocao pelo TTL monitor.
- Necessidade de drop/recreate: nao em MongoDB 5.1+; usar `collMod` para adicionar/alterar `expireAfterSeconds`. Em versoes anteriores, requer drop/recreate manual.
- Risco de bloqueio: baixo para `collMod`, porque nao reconstroi o indice. O risco operacional vem de delecoes TTL em lote se houver muitos documentos expirados.
- Acao: requer acao se a expiracao automatica de briefing sessions e desejada.

Comando preferido, nao executar pelo script:

```javascript
db.runCommand({"collMod":"briefingsessions","index":{"keyPattern":{"expiresAt":1},"expireAfterSeconds":0}})
```

Fallback manual para MongoDB sem suporte a `collMod` para conversao TTL:

```javascript
db.getCollection("briefingsessions").dropIndex("expiresAt_1")
db.getCollection("briefingsessions").createIndex({"expiresAt":1}, {"name":"expiresAt_1","expireAfterSeconds":0})
```

## 2. `projects.briefingSessionId_1`

- Indice atual: `{ key: { briefingSessionId: 1 }, name: "briefingSessionId_1" }`, sem `sparse`.
- Indice desejado: `{ key: { briefingSessionId: 1 }, name: "briefingSessionId_1", sparse: true }`.
- Impacto: `sparse` reduz entradas para documentos sem `briefingSessionId`; nao altera unicidade e nao corrige comportamento funcional porque o indice nao e `unique`. A busca local nao encontrou query path atual em `Project` filtrando por `briefingSessionId`.
- Necessidade de drop/recreate: sim, se a decisao for alinhar exatamente ao schema.
- Risco de bloqueio: moderado para recriacao; se alguma query futura usar `briefingSessionId`, ela pode ficar temporariamente menos eficiente durante a troca.
- Acao: pode ser ignorado para correcao funcional. Considerar migrar apenas se tamanho do indice ou custo de manutencao justificar.

Comandos manuais apenas se a equipe decidir alinhar o `sparse`:

```javascript
db.getCollection("projects").dropIndex("briefingSessionId_1")
db.getCollection("projects").createIndex({"briefingSessionId":1}, {"name":"briefingSessionId_1","sparse":true})
```

## Stripe: estrategia comum para os 6 indices

Os indices Stripe nao precisam manter exatamente o mesmo nome para as consultas da aplicacao; nomes de indices sao relevantes para operacao e para o script de sincronizacao, nao para `findOne`/`findOneAndUpdate`. MongoDB 5.0+ permite indice basico e indice `unique` com o mesmo key pattern quando os nomes sao diferentes. Por isso, a migracao preferida e em etapas:

1. Criar o indice `unique partial` com nome temporario.
2. Validar que o indice temporario existe e que a criacao concluiu.
3. Somente depois remover o indice antigo.
4. Criar o indice canonico com o nome esperado pelo schema, se o MongoDB atual permitir coexistencia temporaria com o equivalente.
5. Validar o canonico.
6. Remover o temporario.

Se o MongoDB atual rejeitar a criacao do canonico enquanto o temporario existir por regra de indice equivalente, manter o temporario e alterar o schema em um deploy separado para usar um nome estavel novo. Nao remover o temporario antes de haver outro indice valido no campo.

## 3. `users.stripeCustomerId_1`

- Indice atual: `{ key: { stripeCustomerId: 1 }, name: "stripeCustomerId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeCustomerId: 1 }, name: "stripeCustomerId_1", unique: true, partialFilterExpression: { stripeCustomerId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeCustomerId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeCustomerId":1}, {"name":"stripeCustomerId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeCustomerId_1")
db.getCollection("users").createIndex({"stripeCustomerId":1}, {"name":"stripeCustomerId_1","unique":true,"partialFilterExpression":{"stripeCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeCustomerId_1" || index.name === "stripeCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeCustomerId_1_unique_partial_tmp")
```

## 4. `users.stripeTestCustomerId_1`

- Indice atual: `{ key: { stripeTestCustomerId: 1 }, name: "stripeTestCustomerId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeTestCustomerId: 1 }, name: "stripeTestCustomerId_1", unique: true, partialFilterExpression: { stripeTestCustomerId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeTestCustomerId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeTestCustomerId":1}, {"name":"stripeTestCustomerId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeTestCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeTestCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeTestCustomerId_1")
db.getCollection("users").createIndex({"stripeTestCustomerId":1}, {"name":"stripeTestCustomerId_1","unique":true,"partialFilterExpression":{"stripeTestCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeTestCustomerId_1" || index.name === "stripeTestCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeTestCustomerId_1_unique_partial_tmp")
```

## 5. `users.stripeLiveCustomerId_1`

- Indice atual: `{ key: { stripeLiveCustomerId: 1 }, name: "stripeLiveCustomerId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeLiveCustomerId: 1 }, name: "stripeLiveCustomerId_1", unique: true, partialFilterExpression: { stripeLiveCustomerId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeLiveCustomerId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeLiveCustomerId":1}, {"name":"stripeLiveCustomerId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeLiveCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeLiveCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeLiveCustomerId_1")
db.getCollection("users").createIndex({"stripeLiveCustomerId":1}, {"name":"stripeLiveCustomerId_1","unique":true,"partialFilterExpression":{"stripeLiveCustomerId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeLiveCustomerId_1" || index.name === "stripeLiveCustomerId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeLiveCustomerId_1_unique_partial_tmp")
```

## 6. `users.stripeSubscriptionId_1`

- Indice atual: `{ key: { stripeSubscriptionId: 1 }, name: "stripeSubscriptionId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeSubscriptionId: 1 }, name: "stripeSubscriptionId_1", unique: true, partialFilterExpression: { stripeSubscriptionId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeSubscriptionId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeSubscriptionId":1}, {"name":"stripeSubscriptionId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeSubscriptionId_1")
db.getCollection("users").createIndex({"stripeSubscriptionId":1}, {"name":"stripeSubscriptionId_1","unique":true,"partialFilterExpression":{"stripeSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeSubscriptionId_1" || index.name === "stripeSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeSubscriptionId_1_unique_partial_tmp")
```

## 7. `users.stripeTestSubscriptionId_1`

- Indice atual: `{ key: { stripeTestSubscriptionId: 1 }, name: "stripeTestSubscriptionId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeTestSubscriptionId: 1 }, name: "stripeTestSubscriptionId_1", unique: true, partialFilterExpression: { stripeTestSubscriptionId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeTestSubscriptionId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeTestSubscriptionId":1}, {"name":"stripeTestSubscriptionId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeTestSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeTestSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeTestSubscriptionId_1")
db.getCollection("users").createIndex({"stripeTestSubscriptionId":1}, {"name":"stripeTestSubscriptionId_1","unique":true,"partialFilterExpression":{"stripeTestSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeTestSubscriptionId_1" || index.name === "stripeTestSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeTestSubscriptionId_1_unique_partial_tmp")
```

## 8. `users.stripeLiveSubscriptionId_1`

- Indice atual: `{ key: { stripeLiveSubscriptionId: 1 }, name: "stripeLiveSubscriptionId_1" }`, nao-unique e sem partial filter.
- Indice desejado: `{ key: { stripeLiveSubscriptionId: 1 }, name: "stripeLiveSubscriptionId_1", unique: true, partialFilterExpression: { stripeLiveSubscriptionId: { $type: "string", $gt: "" } } }`.
- Impacto: impede duplicidade de `stripeLiveSubscriptionId` apenas para strings nao vazias.
- Necessidade de drop/recreate: sim para substituir o nome canonico; nao antes de criar o temporario.
- Risco de bloqueio: moderado por build de indice unique em `users`; falha se surgirem duplicidades durante a janela.
- Acao: requer acao.

```javascript
db.getCollection("users").createIndex({"stripeLiveSubscriptionId":1}, {"name":"stripeLiveSubscriptionId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeLiveSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeLiveSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeLiveSubscriptionId_1")
db.getCollection("users").createIndex({"stripeLiveSubscriptionId":1}, {"name":"stripeLiveSubscriptionId_1","unique":true,"partialFilterExpression":{"stripeLiveSubscriptionId":{"$type":"string","$gt":""}}})
db.getCollection("users").getIndexes().filter((index) => index.name === "stripeLiveSubscriptionId_1" || index.name === "stripeLiveSubscriptionId_1_unique_partial_tmp")
db.getCollection("users").dropIndex("stripeLiveSubscriptionId_1_unique_partial_tmp")
```

## Rollout recomendado

1. Rodar novamente `NODE_ENV=production node scripts/validateMongoIndexReadiness.js` antes da janela.
2. Rodar `NODE_ENV=production node scripts/syncMongoIndexes.js --apply` para criar apenas indices ausentes compativeis. Esperado: cria novos compativeis, pula incompatibilidades, termina com exit code nao-zero enquanto houver incompatibilidade.
3. Aplicar `collMod` de `briefingsessions.expiresAt_1` se a versao MongoDB for 5.1+.
4. Criar os 6 temporarios Stripe, validar criacao, e so entao remover os 6 antigos.
5. Canonicalizar os nomes Stripe ou atualizar o schema para nomes estaveis novos, conforme comportamento confirmado na versao MongoDB atual.
6. Ignorar `projects.briefingSessionId_1` para correcao funcional, salvo se houver decisao operacional de reduzir tamanho/custo do indice.
7. Rodar novo dry-run filtrado por colecao/indice ate nao restarem incompatibilidades que a equipe decidiu resolver.
