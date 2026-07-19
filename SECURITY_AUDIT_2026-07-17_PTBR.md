# Auditoria ofensiva-defensiva de segurança — Fluid SaaS

Data: 2026-07-17  
Escopo: somente `/home/mikaelz/FLUIDBE`, banco/modelos e testes locais.  
Restrições respeitadas: nenhum acesso à produção, nenhuma credencial real usada, nenhum dado de terceiro consultado, nenhuma exfiltração, nenhuma carga destrutiva e `BUILD_WORKER_ENABLED=false` durante toda a validação.

## Resumo executivo

O isolamento entre contas nas rotas principais está consistente no estado auditado. Não encontrei IDOR/BOLA reproduzível: todas as rotas de projeto exigem `authMiddleware`; consultas de projeto vinculam `_id` a `userId`; consultas de build vinculam `_id` a `projectId`; arquivos, mensagens, conectores, publicação e exclusão só são alcançados depois da verificação de propriedade. Todas as rotas administrativas declaradas começam com `requireAdmin`.

O risco residual geral é **alto**. O fator dominante é arquitetural: se o worker for habilitado, `npm run build`, configurações Vite e plugins controlados pelo projeto executam sem sandbox de SO/container. Conteúdo gerado também é servido em uma origem que hospeda páginas/APIs do backend, e o JWT do frontend disponível é legível por JavaScript. Além disso, os limites de IA são contadores locais por processo, não há quota mensal/por plano aplicada no chat e contas locais não exigem verificação de e-mail; essa combinação permite abuso financeiro distribuído.

Correções pequenas aplicadas nesta auditoria:

- bloqueio de SSRF no conector Shopify por allowlist estrita `*.myshopify.com` com HTTPS;
- JWT principal, OAuth state, desafio 2FA e JWT runtime restritos a HS256;
- login sem enumeração explícita de conta OAuth e com comparação bcrypt também para usuário inexistente;
- limites de tamanho antes do bcrypt e normalização/limites no cadastro;
- rate limit dedicado para cadastro e mutações Stripe;
- comparação timing-safe para o token administrativo;
- bloqueio recursivo de `__proto__`, `constructor` e `prototype` no runtime;
- query string removida do log de payload excedido;
- `Referrer-Policy: no-referrer` em previews privados;
- endpoint de debug retorna 404 em produção e `X-Powered-By` foi desabilitado;
- erros do webhook Stripe e nomes de variáveis ausentes deixaram de ser refletidos ao cliente;
- IDs malformados no CRUD de projetos falham antes de consultar o MongoDB.

Não alterei o worker, a arquitetura de sessão/origem, quotas comerciais, a publicação ou o modelo administrativo porque exigem decisão de produto/deploy e testes de compatibilidade.

## Tabela de riscos

| ID | Severidade | Estado | Superfície | Risco resumido |
|---|---|---|---|---|
| C-01 | crítica | aberta, mitigada por flag desligada | worker React/Vite | execução de código não confiável sem sandbox real |
| H-01 | alta | aberta | `/builds/*`, `/p/:slug`, páginas/APIs em `apps.askfluid.now` | conteúdo gerado compartilha origem sensível |
| H-02 | alta | aberta | frontend de settings/autenticação | JWT de sete dias legível por JavaScript/storage |
| H-03 | alta | aberta | `/api/chat`, cadastro | abuso distribuído de IA e criação massiva de contas sem quota durável |
| H-04 | alta | aberta | publicação de builds | scanner detecta segredo, mas publicação não é bloqueada |
| H-05 | alta | corrigida | credencial Shopify | SSRF cega contra hosts HTTPS arbitrários |
| H-06 | alta | aberta; worker desligado | dependências fixas do worker | `vite@5.4.11`/`esbuild` com alertas do npm |
| M-01 | média | aberta | rate limiting geral | contadores em memória, por instância e reinicializáveis |
| M-02 | média | parcialmente corrigida | login/cadastro/runtime | enumeração no cadastro e ausência de verificação de e-mail |
| M-03 | média | aberta | 2FA login/recovery | desafio reutilizável e possível corrida de recovery code |
| M-04 | média | aberta | `/api/admin/*` | token estático, sem identidade/RBAC/auditoria por operador |
| M-05 | média | parcialmente corrigida | preview privado | capability ainda aparece em URL e URLs de assets |
| M-06 | média | aberta | projetos/chat/MongoDB | limites por campo/histórico e quotas de armazenamento incompletos |
| M-07 | média | aberta | runtime register | e-mail enumerável e índice não único permite duplicata concorrente |
| M-08 | média | aberta | webhook Stripe | associação por `$or` entre IDs/metadata é permissiva |
| M-09 | média | corrigida | runtime collections | chaves de prototype pollution aceitáveis em `Mixed` |
| L-01 | baixa | corrigida | logs/erros/debug/headers | query/secrets e detalhes operacionais desnecessários |

## Achados detalhados

### C-01 — execução de código de projeto sem sandbox real

- **Rota/arquivo:** `POST /api/admin/projects/:id/react-vite`; `workers/reactViteBuildWorker.js:163-170`; `routes/adminRoutes.js:2043-2056`.
- **Cenário de abuso:** um ZIP autorizado contém `scripts.build`, `vite.config.*` ou plugin que lê arquivos do host, abre processos, consome CPU/memória ou faz requisições de rede. `--ignore-scripts` bloqueia lifecycle de instalação, mas `npm run build` é execução explícita controlada pelo projeto.
- **Impacto:** comprometimento do worker/host, leitura de `.env`/HOME/Mongo URI, SSRF, pivot de rede, persistência e DoS. A allowlist de env não limita filesystem, processo nem rede.
- **Evidência segura:** revisão estática e teste local existente demonstram que o comando de build controlado é executado e que timeout/filtragem de env são apenas mitigações. Nenhum payload de escape foi executado. A API retorna `BUILD_WORKER_REQUIRED` quando a flag está falsa (`routes/adminRoutes.js:3079-3086`).
- **Correção recomendada:** manter a flag falsa até usar container/VM efêmero sem mounts do host, usuário não-root, filesystem base read-only, workspace descartável, limites de CPU/RAM/PIDs/tempo, seccomp/AppArmor, sem metadata cloud, egress deny-by-default/allowlist e credenciais de banco mínimas. Separar fila/API/worker em identidades e redes diferentes.
- **Teste automatizado:** fixture inofensiva tenta escrever fora do workspace, ler canário fora dele, abrir subprocessos excessivos e acessar host HTTP de teste bloqueado; todos devem falhar, enquanto build normal passa.

### H-01 — conteúdo gerado compartilha origem com superfícies do backend

- **Rota/arquivo:** `server.js:774-889`, especialmente `/builds/*`, `/p/:slug`, `/settings/account` e APIs liberadas no host público.
- **Cenário de abuso:** HTML/JS gerado executa sob `apps.askfluid.now` e tenta ler storage, navegar páginas sensíveis ou abusar de qualquer cookie futuro nessa origem.
- **Impacto:** XSS por desenho/origin confusion; um erro de armazenamento de token/cookie na origem de apps amplia para takeover de conta.
- **Evidência segura:** o servidor entrega HTML/JS arbitrário e deliberadamente não usa CSP global para builds. Não foi executado JavaScript ofensivo.
- **Correção recomendada:** mover previews/publicações para domínio sandbox separado e cookieless, idealmente registrável distinto; APIs/auth/admin ficam fora dele. Aplicar CSP/sandbox compatível, CORP/COOP conforme fluxo e CORS mínimo para runtime.
- **Teste automatizado:** página gerada de teste não consegue ler settings, storage ou respostas autenticadas; não recebe cookies Fluid; preview/assets/runtime continuam funcionais.

### H-02 — token bearer persistente é legível por JavaScript

- **Rota/arquivo:** `public/settings/account/index.html:325-469,541-583`; TTL em `utils/auth.js`.
- **Cenário de abuso:** XSS no frontend lê uma das várias chaves de `localStorage`/`sessionStorage` procuradas pela página e reutiliza o JWT.
- **Impacto:** acesso à conta/projetos por até sete dias, limitado por logout/revogação de sessão.
- **Evidência segura:** busca estática mostra leitura de várias chaves genéricas de token; nenhuma extração de token real foi feita.
- **Correção recomendada:** access token curto em memória + refresh HttpOnly rotativo, ou sessão HttpOnly `Secure`/`SameSite` com CSRF. Remover busca por chaves genéricas, externalizar script inline e aplicar CSP com nonce/hash.
- **Teste automatizado:** storage/cookies acessíveis ao JS não contêm segredo reutilizável; refresh rotaciona e detecta replay; mutações com cookie rejeitam CSRF inválido.

### H-03 — abuso de custos de IA e contas em massa

- **Rota/arquivo:** `POST /api/chat`, `POST /api/chat/clarify`, `POST /api/auth/register`; `routes/chatRoutes.js:14-18,1449-1566`; `routes/billingRoutes.js:10-40`.
- **Cenário de abuso:** automação distribui IPs/contas, chama IA em paralelo e reinicia/alternar instâncias contorna contadores locais. O plano free anuncia limite de mensagens, mas o chat não consulta quota/ledger durável. Cadastro local não verifica e-mail.
- **Impacto:** gasto Anthropic/OpenAI, crescimento de Mongo, spam e degradação para usuários legítimos.
- **Evidência segura:** somente revisão de fluxo; nenhum request ao provedor foi enviado. O limitador de chat é 30/usuário/15 min e 60/IP/15 min, mas não é quota financeira compartilhada.
- **Correção recomendada:** ledger atômico Redis/DB por usuário/plano/período e por projeto, limite de concorrência, reserva de custo antes da chamada, reconciliação depois, orçamento global/circuit breaker e verificação de e-mail/CAPTCHA adaptativo. Idempotency key para operações caras.
- **Teste automatizado:** duas instâncias concorrentes não ultrapassam quota; 31 requests paralelos têm limite determinístico; contas não verificadas não consomem IA; orçamento global abre circuit breaker.

### H-04 — scanner de segredo não bloqueia publicação

- **Rota/arquivo:** scan em `utils/projectPublication.js:502-579`; publicação em `utils/projectPublication.js:582-705`; endpoints de scan/publicação em `routes/projectRoutes.js:1250-1348`.
- **Cenário de abuso:** um build contém chave, private key, `.env` ou URI Mongo; o scanner retorna `blocked`, mas publicar não chama/verifica o scan.
- **Impacto:** exposição pública de segredo e custos/comprometimento de serviços conectados.
- **Evidência segura:** análise de call graph; `publishProjectBuild` não invoca `scanBuildSecurity`. Foram usados apenas padrões/canários de teste existentes.
- **Correção recomendada:** scan obrigatório server-side imediatamente antes da transição atômica draft→done; achado crítico bloqueia. Exceção somente com reautenticação, justificativa e auditoria. Scanner é camada adicional, não substitui secret manager.
- **Teste automatizado:** build com canário de private key/Mongo/OpenAI retorna 409 e não muda status/publicação; build limpo publica; override auditado exige permissão separada.

### H-05 — SSRF no validador Shopify — corrigida

- **Rota/arquivo:** `POST /api/projects/:projectId/connectors/shopify/credentials`; `routes/projectRoutes.js:174-199,278-284,395-403`.
- **Cenário de abuso:** antes, `https://127.0.0.1`, host interno ou domínio arbitrário passava porque qualquer valor começando com HTTPS era aceito; o backend fazia fetch com timeout.
- **Impacto:** SSRF cega, descoberta de serviços internos e envio do header fornecido a destino arbitrário.
- **Evidência segura:** PoC unitária apenas normalizou URLs, sem fazer rede; casos localhost, userinfo e sufixo falso agora retornam vazio.
- **Correção aplicada:** HTTPS obrigatório, sem userinfo e hostname ASCII de uma única loja terminando exatamente em `.myshopify.com`.
- **Teste automatizado:** `tests/security-hardening.test.js` cobre host válido, localhost, domínio `myshopify.com.evil`, userinfo e HTTP.

### H-06 — dependências fixas vulneráveis fora do lock principal

- **Rota/arquivo:** `routes/adminRoutes.js:63-70,2067-2091`.
- **Cenário de abuso:** o worker instala `vite@5.4.11` e transitive `esbuild`; essas versões não fazem parte do `package-lock.json` do backend e escapam ao audit normal.
- **Impacto:** alertas de traversal/leitura do Vite e exposição de servidor de desenvolvimento; o impacto maior continua sendo a falta de sandbox.
- **Evidência segura:** package temporário em `/tmp`, `npm install --package-lock-only --ignore-scripts` e `npm audit --json`: 1 high + 1 moderate. O lock principal: 0 vulnerabilidades em 189 dependências. Registro oficial reportou Vite atual 8.1.5 com Node `^20.19.0 || >=22.12.0`.
- **Correção recomendada:** imagem de build versionada com lock próprio e SBOM, versão suportada do Node, Vite/plugin atualizados e auditados; não instalar toolchain ad hoc em cada projeto. Validar major upgrade antes de mudar.
- **Teste automatizado:** CI audita tanto o lock do backend quanto o lock da imagem/toolchain; falha em high/critical e testa build de fixtures React/Vite.

### M-01 — rate limiting é local por processo

- **Rota/arquivo:** `middleware/rateLimit.js`; mounts em `server.js`; limits em auth/chat/runtime/billing/admin.
- **Cenário de abuso:** reinício ou múltiplas instâncias dão novos mapas; IPs distribuídos e eventual spoof de proxy contornam proteção.
- **Impacto:** brute force, criação em massa, custos e DoS.
- **Evidência segura:** `createRateLimit` usa `new Map()`; nenhuma carga foi disparada.
- **Correção recomendada:** Redis compartilhado com operação atômica e TTL; chaves compostas IP + hash de conta/usuário; validar cadeia de proxy e preservar `Retry-After`.
- **Teste automatizado:** duas instâncias compartilham contador, restart não zera janela e `X-Forwarded-For` não é aceito fora do proxy confiável.

### M-02 — enumeração/cadastro e verificação de e-mail incompletos

- **Rota/arquivo:** `POST /api/auth/register`, `POST /api/auth/login`; `routes/authRoutes.js:1860-2029`.
- **Cenário de abuso:** cadastro responde explicitamente que e-mail existe; contas podem ser criadas e usadas sem provar posse do e-mail. O login também distinguia conta OAuth, corrigido nesta auditoria.
- **Impacto:** enumeração, spam, impersonação por e-mail não verificado e base para abuso de custos.
- **Evidência segura:** handlers foram exercitados com mocks; conta inexistente e OAuth agora retornam o mesmo 401 e fazem bcrypt dummy. Nenhum e-mail real foi testado.
- **Correção recomendada:** cadastro sempre responde de forma indistinguível e envia link curto/single-use; conta não verificada não usa recursos caros. Rate limit compartilhado por IP + hash de e-mail e CAPTCHA adaptativo.
- **Teste automatizado:** existente/não existente têm corpo/status/latência equivalentes; token de verificação é single-use; conta não verificada não chama IA.

### M-03 — desafio 2FA pode ser reutilizado

- **Rota/arquivo:** `routes/authRoutes.js:801-809,1916-1985`.
- **Cenário de abuso:** desafio JWT de cinco minutos não possui estado de consumo; desafio roubado + TOTP atual pode criar mais de uma sessão. Duas requisições concorrentes podem validar o mesmo recovery code antes do save.
- **Impacto:** sessões extras após interceptação e replay.
- **Evidência segura:** revisão estática; nenhum código 2FA real usado.
- **Correção recomendada:** `jti` aleatório com hash persistido e consumo atômico; recovery code reivindicado por update condicional/transação; revogar desafios após troca de senha/2FA.
- **Teste automatizado:** duas submissões concorrentes do mesmo desafio/recovery code: exatamente uma tem sucesso.

### M-04 — autenticação administrativa é um segredo estático global

- **Rota/arquivo:** todas `/api/admin/*`; `routes/adminRoutes.js:358-365`.
- **Cenário de abuso:** vazamento do único token concede leitura/escrita/build em todos os tenants, sem identidade individual.
- **Impacto:** takeover administrativo e baixa rastreabilidade.
- **Evidência segura:** todas as 19 rotas admin foram enumeradas localmente e começam com `requireAdmin`; a comparação agora é timing-safe. Token real não foi lido.
- **Correção recomendada:** SSO/MFA, sessão curta, RBAC/scopes, VPN/IAP ou allowlist de rede, rotação e log de auditoria por operador/ação/recurso. Token estático apenas como segundo fator transitório.
- **Teste automatizado:** identidade expirada/revogada e scope insuficiente falham; evento auditável contém operador/tenant/recurso sem payload sensível.

### M-05 — preview capability permanece em URLs

- **Rota/arquivo:** `utils/buildPreviewAccess.js`, `utils/buildAssetCapabilities.js`, `server.js:474-480,609-648`.
- **Cenário de abuso:** `previewToken` aparece na URL inicial e é propagado a assets; pode persistir em histórico, telemetria de proxy, performance entries ou código do próprio preview.
- **Impacto:** acesso de leitura ao mesmo build privado por até 15 minutos; token é limitado a projeto/build.
- **Evidência segura:** testes unitários confirmam binding/TTL/propagação. Nesta auditoria foi adicionado `no-referrer` em artefatos privados e logs próprios não registram query.
- **Correção recomendada:** trocar capability da query por código single-use que vira cookie HttpOnly e redireciona para URL limpa, ou signed cookies/CDN; garantir compatibilidade com iframe sandbox/third-party cookies antes da migração.
- **Teste automatizado:** URL final, logs, Referer e assets não contêm token; token alterado/build diferente/expirado falha; cookie é path-scoped.

### M-06 — limites de campos, histórico e armazenamento incompletos

- **Rota/arquivo:** projetos/model `Project`, chat/history e `express.json({limit:'100kb'})` em `server.js:781`.
- **Cenário de abuso:** usuário acumula projetos/mensagens, usa strings próximas do limite global e histórico multipart grande; Mongo/provider processam conteúdo além do necessário.
- **Impacto:** custo, latência, documentos grandes e DoS gradual.
- **Evidência segura:** revisão dos schemas/normalização; upload de imagem já limita 8 MiB e valida assinatura PNG/JPEG/WebP.
- **Correção recomendada:** limites por campo e por coleção/plano; total de histórico e tokens; paginação/cursor; quota de armazenamento; índices e TTL/retention onde aplicável. Não aumentar o limite global.
- **Teste automatizado:** boundary `N`/`N+1`, array/objeto onde se espera string, total de histórico e quota concorrente.

### M-07 — cadastro runtime permite enumeração e duplicata concorrente

- **Rota/arquivo:** `POST /api/runtime/:projectId/auth/register`; `routes/runtimeRoutes.js:124-169`; `models/RuntimeDocument.js:40`.
- **Cenário de abuso:** resposta 409 confirma e-mail por projeto; check-then-create não é protegido por índice único.
- **Impacto:** enumeração de usuários finais e duas contas para o mesmo e-mail em corrida.
- **Evidência segura:** índice atual `{projectId, collection, data.email}` não é `unique`; nenhum banco real foi consultado.
- **Correção recomendada:** índice único parcial para `collection:'_users'` após migração/deduplicação, resposta genérica e verificação de e-mail conforme o app.
- **Teste automatizado:** 20 cadastros concorrentes do mesmo e-mail resultam em um documento; respostas não revelam existência.

### M-08 — associação permissiva em webhooks Stripe

- **Rota/arquivo:** `routes/billingRoutes.js:285-443`, webhook `445-498`.
- **Cenário de abuso:** evento Stripe válido pode trazer customer/subscription/userId inconsistentes; query `$or` atualiza o primeiro usuário que casar com qualquer identificador.
- **Impacto:** entitlement aplicado à conta errada em caso de metadata inconsistente, replay operacional ou integração comprometida.
- **Evidência segura:** assinatura é verificada corretamente; análise estática do `$or`, sem webhook real.
- **Correção recomendada:** exigir consistência entre todos os IDs presentes, mapear por customer/subscription já vinculados e aceitar metadata `userId` somente no bootstrap de checkout criado pelo backend; guardar/rejeitar event IDs repetidos.
- **Teste automatizado:** evento assinado de fixture com IDs conflitantes não altera usuário; replay do mesmo event ID é idempotente.

### M-09 — prototype pollution no runtime — corrigida

- **Rota/arquivo:** collections create/patch; `utils/runtimeValidation.js:16,42-59`.
- **Cenário de abuso:** payload JSON com `constructor.prototype` ou `__proto__` era aceito em dados `Mixed` e poderia contaminar consumidores que fazem merge inseguro.
- **Impacto:** comportamento inesperado, possível autorização/execução em componentes downstream vulneráveis.
- **Evidência segura:** PoC unitária com `JSON.parse`, sem mutar protótipos globais; payload agora é rejeitado.
- **Correção aplicada:** bloqueio recursivo das três chaves mágicas, além de `$`, ponto, `projectId` e `ownerId` já bloqueados.
- **Teste automatizado:** `tests/security-hardening.test.js`.

### L-01 — minimização de erro/log/debug/headers — corrigida

- **Rota/arquivo:** `utils/payloadErrors.js`, `routes/billingRoutes.js`, `server.js`, auth/admin.
- **Cenário de abuso:** segredo em query aparecia no log de 413; webhook refletia detalhe do SDK; endpoint debug era público em produção; Express revelava assinatura; token admin era comparado diretamente.
- **Impacto:** vazamento em logs e auxílio de reconhecimento.
- **Evidência segura:** canário `previewToken=must-not-be-logged` no teste; apenas path é registrado.
- **Correção aplicada:** sanitização descrita no resumo e testes de regressão.
- **Teste automatizado:** `tests/payload-errors.test.js` e `tests/security-hardening.test.js`.

## Como um atacante tentaria abusar — respostas às 15 perguntas

1. **Projeto alheio por ID:** trocar `_id/projectId`, combinar projeto próprio com `buildId` alheio e tentar IDs antigos. Estado atual: filtros `_id+userId` e `_id+projectId` retornam 404; testes cobrem GET/PUT/DELETE e runtime scope.
2. **Editar/deletar/publicar/ver conta alheia:** repetir troca de IDs em CRUD, mensagens, arquivos, conectores e publish; tentar mass assignment de `userId`, `latestPublishedBuildId`, artefatos e URLs. Estado atual: allowlist do update descarta campos protegidos; ownership precede ações.
3. **Forjar/reusar JWT:** tentar `alg:none`, HS384, segredo fraco, token runtime na API principal, JWT expirado e sessão revogada. Estado atual: HS256 fixo, separação runtime em produção, `jti` consultado e expiração/revogação aplicadas. Risco residual: segredo/rotação e token browser H-02.
4. **Descobrir usuários:** comparar login inexistente/OAuth/local, cadastro existente e runtime register. Login principal foi uniformizado; cadastro principal/runtime ainda enumeram.
5. **Brute force:** distribuir IPs em login, 2FA, cadastro, OAuth e eventuais convites/reset. Não há reset/convite neste repo. Limites locais existem, mas M-01 permanece.
6. **Provocar gastos:** contas em massa + chat paralelo, imagens de 8 MiB, connector validation, checkout/portal e builds admin. Cadastro/billing ganharam limites; quota financeira durável de IA permanece H-03.
7. **DoS:** JSON próximo a 100 KiB, multipart, ZIP bomb, muitos arquivos, loop de build, logs grandes e conexões paralelas. Há limites de JSON/upload/ZIP/dist/timeout/buffer; worker sem cgroup/sandbox e quotas persistentes continuam riscos.
8. **HTML/JS/SVG/ZIP malicioso:** chat aceita apenas PNG/JPEG/WebP por MIME+magic; ZIP valida traversal, symlink, razão, entries e tamanho; HTML/JS gerado é servido/executado por desenho, exigindo origem sandbox.
9. **Escapar sandbox/executar servidor:** usar `npm run build`, Vite config/plugin, filesystem/process/network. Não existe sandbox real; worker deve continuar desligado até C-01 ser resolvido.
10. **Persistir/roubar segredos:** XSS lê JWT de storage; previewToken em URL; build lê HOME/filesystem; fonte/publicação contém chave; logs capturam query. Patches reduziram logs/referer/env, mas H-02/H-04/C-01 permanecem. `.env` está ignorado e nenhum segredo hardcoded rastreado foi encontrado.
11. **CORS/CSRF/XSS/SSRF/traversal/prototype/NoSQL/mass assignment:** CORS usa allowlist; bearer reduz CSRF; XSS de conteúdo gerado exige isolamento; SSRF Shopify e prototype pollution foram corrigidos; traversal ZIP/files usa resolve+realpath; filtros runtime bloqueiam operadores; updates de projeto são allowlist.
12. **Admin/rotas esquecidas:** enumerar todas as rotas, tentar JWT normal e token vazio/fraco; todas as rotas admin começam com `requireAdmin`. Debug agora é 404 em produção. M-04 continua.
13. **URLs/assets publicados:** trocar project/build key, `..`, encoding duplo, URL absoluta e `buildId` antigo. Parser normaliza/rejeita traversal; apenas `latestPublishedBuildId` done é público; preview privado é capability-bound.
14. **Logs/erros/stack:** induzir JSON 413, webhook inválido, Mongo cast, provider/build failure e procurar prompt/token/URI. Erros públicos são majoritariamente genéricos; build logs têm redaction; queries agora são removidas do log 413. Validar também proxy/APM externo.
15. **Contas/spam/automação:** cadastro local distribuído, runtime por projeto e OAuth em massa; falta verificação de e-mail/CAPTCHA/ledger compartilhado. Rate limit dedicado reduz, mas não encerra M-01/M-02/H-03.

## Top 10 vulnerabilidades/caminhos mais prováveis

1. Abuso distribuído de IA por contas não verificadas e quota não durável (H-03).
2. Roubo de JWT caso exista XSS no frontend que usa storage (H-02).
3. Abuso da origem compartilhada por conteúdo gerado (H-01).
4. Bypass de rate limit por múltiplas instâncias/IPs/restart (M-01).
5. Enumeração e automação de cadastro principal/runtime (M-02/M-07).
6. Vazamento de preview capability em URL/telemetria (M-05).
7. Comprometimento amplo após vazamento do token admin estático (M-04).
8. Publicação acidental de segredo apesar do scanner (H-04).
9. DoS/custo por armazenamento/histórico sem limites por campo/plano (M-06).
10. Execução do build sem sandbox se a flag for habilitada, agravada por toolchain vulnerável (C-01/H-06).

IDOR/BOLA não entrou como vulnerabilidade atual porque os testes e a revisão não encontraram bypass. Deve continuar como teste de regressão prioritário.

## Controles positivos verificados

- JWT expirado/revogado e sessão sem `jti` são rejeitados nas rotas privadas; token runtime não vale na API principal.
- OAuth state é assinado, expira e é vinculado a cookie HttpOnly callback-scoped.
- Toda rota de projeto/admin começa pelo gate correto; ownership e vínculo build→project falham fechados.
- Preview privado é HMAC de 15 minutos, ligado a projeto/build; publicado exige build ID explícito.
- Runtime aplica project/collection/owner scope e políticas conservadoras por default.
- Upload de imagem usa memory limit, contagem de parts/fields e magic bytes; SVG/HTML/JS não entram nesse upload.
- ZIP rejeita traversal, caminhos absolutos, symlink, entry/total/ratio excessivos; dist rejeita links/devices/FIFO/socket.
- CORS usa allowlist exata e credenciais apenas para origem aceita; API envia `no-store` e headers básicos.
- `.env` não é rastreado; busca por padrões não encontrou segredo real em arquivos versionados.
- `npm audit` do backend retornou 0 vulnerabilidades; a exceção da toolchain do worker está em H-06.

## Arquivos alterados

- `middleware/authMiddleware.js`
- `routes/adminRoutes.js`
- `routes/authRoutes.js`
- `routes/billingRoutes.js`
- `routes/projectRoutes.js`
- `server.js`
- `utils/auth.js`
- `utils/payloadErrors.js`
- `utils/runtimeAuth.js`
- `utils/runtimeValidation.js`
- `utils/timingSafe.js` (novo)
- `tests/authorization-boundaries.test.js` (novo)
- `tests/security-hardening.test.js` (novo)
- `tests/payload-errors.test.js`
- `tests/project-update.test.js`
- `SECURITY_AUDIT_2026-07-17_PTBR.md` (novo)

## Testes e verificações executados

- `node --check` nos arquivos alterados e `git diff --check`: passou.
- `BUILD_WORKER_ENABLED=false node --test tests/*.test.js`: **49 testes passaram**.
- Primeira execução sandboxed: único erro foi `mkfifo EPERM` no teste defensivo existente; reexecução local autorizada fora da restrição passou, sem habilitar worker.
- PoCs unitárias: SSRF hostname-only; prototype pollution; JWT HS384; enumeração login; oversized password; IDOR filters; runtime tenant scope; log query redaction.
- `npm audit --json`: 0 vulnerabilidades no lock principal (189 dependências).
- audit isolado da toolchain fixada pelo worker, sem scripts: 1 high + 1 moderate.
- enumeração local das rotas: 19 admin com `requireAdmin`; 15 projetos com `authMiddleware`.
- busca de segredo somente por padrões/nomes, sem imprimir `.env`: nenhum segredo versionado encontrado.

## Snapshot Git da entrega

`git diff --stat`:

```text
 middleware/authMiddleware.js |  2 +-
 routes/adminRoutes.js        |  3 ++-
 routes/authRoutes.js         | 57 ++++++++++++++++++++++++++------------------
 routes/billingRoutes.js      | 18 +++++++++-----
 routes/projectRoutes.js      | 38 ++++++++++++++++++++---------
 server.js                    | 18 ++++++++++++--
 tests/payload-errors.test.js |  2 +-
 tests/project-update.test.js |  4 ++++
 utils/auth.js                |  2 +-
 utils/payloadErrors.js       | 11 ++++++++-
 utils/runtimeAuth.js         |  4 ++--
 utils/runtimeValidation.js   |  2 ++
 12 files changed, 112 insertions(+), 49 deletions(-)
```

`git status --short`:

```text
 M middleware/authMiddleware.js
 M routes/adminRoutes.js
 M routes/authRoutes.js
 M routes/billingRoutes.js
 M routes/projectRoutes.js
 M server.js
 M tests/payload-errors.test.js
 M tests/project-update.test.js
 M utils/auth.js
 M utils/payloadErrors.js
 M utils/runtimeAuth.js
 M utils/runtimeValidation.js
?? SECURITY_AUDIT_2026-07-17_PTBR.md
?? tests/authorization-boundaries.test.js
?? tests/security-hardening.test.js
?? utils/timingSafe.js
```

Nenhum commit ou push foi realizado.
