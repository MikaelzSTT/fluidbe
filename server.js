const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const chatRoutes = require('./routes/chatRoutes');
const adminRoutes = require('./routes/adminRoutes');
const connectorRegistryRoutes = require('./routes/connectorRegistryRoutes');
const billingRoutes = require('./routes/billingRoutes');
const runtimeRoutes = require('./routes/runtimeRoutes');
const Project = require('./models/Project');
const ProjectBuild = require('./models/ProjectBuild');
const Session = require('./models/Session');
const { createRateLimit, getAdminTokenKey, getClientIp } = require('./middleware/rateLimit');
const {
  BUILD_PREVIEW_TTL_SECONDS,
  createBuildPreviewToken,
  verifyBuildPreviewToken,
} = require('./utils/buildPreviewAccess');
const {
  injectBuildPreviewTokenIntoCodeAssets,
  injectBuildPreviewTokenIntoHtmlAssets,
} = require('./utils/buildAssetCapabilities');
const { isProjectBuildExplicitlyPublished } = require('./utils/buildPublicationAccess');


dotenv.config();

const app = express();

const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_BUILDS_DIR = path.join(PUBLIC_DIR, 'builds');
const SETTINGS_ACCOUNT_HTML_PATH = path.join(PUBLIC_DIR, 'settings', 'account', 'index.html');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://apps.askfluid.now').replace(/\/+$/, '');
const PUBLIC_APP_HOST = new URL(PUBLIC_BASE_URL).hostname.toLowerCase();
const APPS_CUSTOM_HOST = 'apps.askfluid.now';
const APEX_CUSTOM_HOST = 'askfluid.now';
const PUBLIC_APP_HOSTS = new Set([PUBLIC_APP_HOST, APPS_CUSTOM_HOST, APEX_CUSTOM_HOST]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const allowedOrigins = [
  'https://askfluid.now',
  'https://www.askfluid.now',
  'https://apps.askfluid.now',
  'https://fluid-web-static.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const baseCorsOptions = {
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-admin-key'],
  optionsSuccessStatus: 204
};
function corsOptions(req, callback) {
  const origin = req.header('Origin');
  const isAllowedOrigin = allowedOrigins.includes(origin);

  callback(null, {
    ...baseCorsOptions,
    origin: isAllowedOrigin ? origin : false,
    credentials: isAllowedOrigin,
  });
}
const apiRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: getClientIp,
});
const loginRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: getClientIp,
});
const chatIpRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: getClientIp,
});
const adminRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => `${getClientIp(req)}:${getAdminTokenKey(req)}`,
});

function getContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getArtifactContentType(artifact, fallbackPath) {
  const artifactPath = artifact.relativePath || artifact.path || fallbackPath;
  const pathContentType = getContentType(artifactPath);
  const storedContentType = artifact.mimeType || artifact.contentType || '';

  if (!storedContentType || storedContentType === 'application/octet-stream') {
    return pathContentType;
  }

  return storedContentType;
}

function isEmbeddableBuildRoute(req) {
  const pathname = req.path || '';

  // Published pages and build artifacts are intentionally embedded by the
  // Fluid frontend, which can be hosted on a different origin.
  return pathname.startsWith('/builds/') || /^\/p\/[^/]+\/?$/.test(pathname);
}

function isPublicAppHost(req) {
  return PUBLIC_APP_HOSTS.has(String(req.hostname || '').toLowerCase());
}

function isPublicRuntimeApiRoute(pathname) {
  return pathname === '/api/runtime' || pathname.startsWith('/api/runtime/');
}

function isPublicAuthApiRoute(pathname) {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

function isPublicFrontendApiRoute(pathname) {
  return (
    isPublicAuthApiRoute(pathname)
    || pathname === '/api/projects'
    || pathname.startsWith('/api/projects/')
    || pathname === '/api/chat'
    || pathname.startsWith('/api/chat/')
    || pathname === '/api/billing'
    || pathname.startsWith('/api/billing/')
    || isPublicRuntimeApiRoute(pathname)
  );
}

function isSettingsAccountRoute(pathname) {
  return /^\/settings\/account(?:\/|\/index\.html)?$/.test(pathname);
}

function isSettingsDebugRoute(pathname) {
  return pathname === '/debug/settings-build';
}

function publicAppsOnly(req, res, next) {
  if (!isPublicAppHost(req)) {
    return next();
  }

  const pathname = req.path || '';
  const hostname = String(req.hostname || '').toLowerCase();

  if (hostname === APEX_CUSTOM_HOST) {
    if (isSettingsAccountRoute(pathname) || isSettingsDebugRoute(pathname)) {
      return next();
    }

    console.log('publicAppsOnly blocked', req.hostname, req.path);
    return res.sendStatus(404);
  }

  if (
    pathname === '/'
    || /^\/p\/[^/]+\/?$/.test(pathname)
    || isSettingsAccountRoute(pathname)
    || isSettingsDebugRoute(pathname)
    || pathname.startsWith('/builds/')
    || isPublicFrontendApiRoute(pathname)
  ) {
    return next();
  }

  console.log('publicAppsOnly blocked', req.hostname, req.path);
  return res.sendStatus(404);
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=()'
  );

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  if ((req.path || '').startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  // Do not send a global CSP here. Published builds contain generated HTML,
  // scripts, styles, and third-party resources whose requirements vary per
  // project. A restrictive policy at this layer would break valid builds.
  if (!isEmbeddableBuildRoute(req)) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  next();
}

function resolvePublicBuildIndexPath(buildUrl) {
  if (typeof buildUrl !== 'string') {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(new URL(buildUrl, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const relativeBuildPath = pathname.slice('/builds/'.length);
  const requestedPath = path.basename(relativeBuildPath) === 'index.html'
    ? relativeBuildPath
    : path.join(relativeBuildPath, 'index.html');
  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);
  const indexPath = path.resolve(buildsRoot, requestedPath);

  if (indexPath !== buildsRoot && !indexPath.startsWith(`${buildsRoot}${path.sep}`)) {
    return null;
  }

  return indexPath;
}

function rewriteBuildAssetPaths(html, buildUrl) {
  if (typeof html !== 'string' || !html || typeof buildUrl !== 'string' || !buildUrl) {
    return html || '';
  }

  const buildPath = new URL(buildUrl, 'http://localhost').pathname;

  if (!buildPath.startsWith('/builds/')) {
    return html;
  }

  const buildBasePath = buildPath.endsWith('/index.html')
    ? buildPath.slice(0, -'index.html'.length)
    : `${buildPath.replace(/\/+$/, '')}/`;

  return html
    .replaceAll('src="./assets/', `src="${buildBasePath}assets/`)
    .replaceAll("src='./assets/", `src='${buildBasePath}assets/`)
    .replaceAll('href="./assets/', `href="${buildBasePath}assets/`)
    .replaceAll("href='./assets/", `href='${buildBasePath}assets/`)
    .replaceAll('url(./assets/', `url(${buildBasePath}assets/`)
    .replaceAll('url("./assets/', `url("${buildBasePath}assets/`)
    .replaceAll("url('./assets/", `url('${buildBasePath}assets/`);
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getPublishedSeo(project) {
  const seo = project?.seo || {};
  const title = String(seo.title || project?.appName || project?.name || project?.title || 'Fluid App').trim().slice(0, 60) || 'Fluid App';
  const description = String(seo.description || project?.prompt || project?.description || 'Built with Fluid').trim().slice(0, 160) || 'Built with Fluid';
  const socialImage = String(seo.socialImage || '').trim();

  return {
    title,
    description,
    socialImage,
  };
}

function getPublishedProjectUrl(project) {
  const slug = String(project?.slug || '').trim();
  return slug ? `${PUBLIC_BASE_URL}/p/${encodeURIComponent(slug)}` : PUBLIC_BASE_URL;
}

function getMetaTagMatcher(attributeName, attributeValue) {
  return new RegExp(
    `<meta\\b(?=[^>]*\\s${attributeName}=["']${attributeValue}["'])[^>]*>`,
    'gi'
  );
}

function injectTagIntoHead(html, tag) {
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n${tag}`);
  }

  const headBlock = `<head>\n${tag}\n</head>`;

  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}\n${headBlock}`);
  }

  return `${headBlock}\n${html}`;
}

function upsertHeadTag(html, matcher, tag) {
  return injectTagIntoHead(html.replace(matcher, ''), tag);
}

function removeHeadTag(html, matcher) {
  return html.replace(matcher, '');
}

function injectPublishedSeo(html, project) {
  if (typeof html !== 'string' || !html) {
    return html || '';
  }

  const seo = getPublishedSeo(project);
  const title = escapeHtmlAttribute(seo.title);
  const description = escapeHtmlAttribute(seo.description);
  const socialImage = escapeHtmlAttribute(seo.socialImage);
  const publicUrl = escapeHtmlAttribute(getPublishedProjectUrl(project));
  const twitterCard = socialImage ? 'summary_large_image' : 'summary';
  let updatedHtml = html;

  updatedHtml = upsertHeadTag(updatedHtml, /<title\b[^>]*>[\s\S]*?<\/title>/gi, `<title>${title}</title>`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('name', 'description'), `<meta name="description" content="${description}">`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:title'), `<meta property="og:title" content="${title}">`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:description'), `<meta property="og:description" content="${description}">`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:type'), '<meta property="og:type" content="website">');
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:url'), `<meta property="og:url" content="${publicUrl}">`);

  if (socialImage) {
    updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:image'), `<meta property="og:image" content="${socialImage}">`);
  } else {
    updatedHtml = removeHeadTag(updatedHtml, getMetaTagMatcher('property', 'og:image'));
  }

  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('name', 'twitter:card'), `<meta name="twitter:card" content="${twitterCard}">`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('name', 'twitter:title'), `<meta name="twitter:title" content="${title}">`);
  updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('name', 'twitter:description'), `<meta name="twitter:description" content="${description}">`);

  if (socialImage) {
    updatedHtml = upsertHeadTag(updatedHtml, getMetaTagMatcher('name', 'twitter:image'), `<meta name="twitter:image" content="${socialImage}">`);
  } else {
    updatedHtml = removeHeadTag(updatedHtml, getMetaTagMatcher('name', 'twitter:image'));
  }

  return updatedHtml;
}

function parseBuildRequestPath(requestPath) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(requestPath, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const parts = pathname.slice('/builds/'.length).split('/').filter(Boolean);

  if (parts.length < 2 || !mongoose.Types.ObjectId.isValid(parts[0])) {
    return null;
  }

  const projectId = parts[0];
  const buildKey = parts[1];
  const artifactPath = parts.slice(2).join('/') || 'index.html';
  const indexBuildUrl = `/builds/${projectId}/${buildKey}/index.html`;

  if (artifactPath.split('/').some((segment) => segment === '..')) {
    return null;
  }

  return {
    projectId,
    buildKey,
    artifactPath,
    indexBuildUrl,
  };
}

async function getBearerUserId(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.id || !decoded.jti || decoded.runtimeUserId) {
      return null;
    }

    const session = await Session.exists({
      jti: decoded.jti,
      userId: decoded.id,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });

    return session ? decoded.id : null;
  } catch (error) {
    return null;
  }
}

function getCookie(req, name) {
  const header = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  const prefix = `${name}=`;
  const part = header.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!part) return '';
  try {
    return decodeURIComponent(part.slice(prefix.length));
  } catch (error) {
    return '';
  }
}

function hasOpaqueSandboxOrigin(req) {
  return String(req.headers.origin || '') === 'null';
}

function setSandboxBuildCorsHeaders(req, res) {
  if (!hasOpaqueSandboxOrigin(req)) {
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function applyBuildArtifactCors(req, res, next) {
  setSandboxBuildCorsHeaders(req, res);

  if (req.buildAccess && req.buildAccess.isPublished !== true) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

async function serveBuildIndexWithCapabilities(req, res, next) {
  const access = req.buildAccess;

  if (
    !access ||
    access.isPublished === true ||
    !access.previewToken ||
    access.parsedPath.artifactPath !== 'index.html'
  ) {
    return next();
  }

  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);
  const indexPath = path.resolve(
    buildsRoot,
    access.parsedPath.projectId,
    access.parsedPath.buildKey,
    'index.html'
  );

  if (indexPath !== buildsRoot && !indexPath.startsWith(`${buildsRoot}${path.sep}`)) {
    return res.sendStatus(404);
  }

  try {
    const html = await fs.readFile(indexPath, 'utf8');
    return res
      .type('html')
      .send(injectBuildPreviewTokenIntoHtmlAssets(html, access.parsedPath, access.previewToken));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return next();
    }

    return next(error);
  }
}

async function serveBuildCodeAssetWithCapabilities(req, res, next) {
  const access = req.buildAccess;

  if (
    !access ||
    access.isPublished === true ||
    !access.previewToken ||
    !/\.(?:css|js|mjs)$/.test(access.parsedPath.artifactPath)
  ) {
    return next();
  }

  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);
  const assetPath = path.resolve(
    buildsRoot,
    access.parsedPath.projectId,
    access.parsedPath.buildKey,
    access.parsedPath.artifactPath
  );

  if (assetPath !== buildsRoot && !assetPath.startsWith(`${buildsRoot}${path.sep}`)) {
    return res.sendStatus(404);
  }

  try {
    const code = await fs.readFile(assetPath, 'utf8');
    return res
      .type(path.extname(assetPath).toLowerCase() === '.css' ? 'css' : 'js')
      .send(injectBuildPreviewTokenIntoCodeAssets(code, access.parsedPath, access.previewToken));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return next();
    }

    return next(error);
  }
}

function buildUrlMatchQuery(indexBuildUrl) {
  const escapedIndexBuildUrl = indexBuildUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absoluteIndexBuildUrlPattern = new RegExp(`${escapedIndexBuildUrl}$`);

  return {
    $or: [
      { distUrl: indexBuildUrl },
      { previewUrl: indexBuildUrl },
      { buildUrl: indexBuildUrl },
      { deployUrl: indexBuildUrl },
      { distUrl: absoluteIndexBuildUrlPattern },
      { previewUrl: absoluteIndexBuildUrlPattern },
      { buildUrl: absoluteIndexBuildUrlPattern },
      { deployUrl: absoluteIndexBuildUrlPattern },
    ],
  };
}

async function authorizeBuildAccess(req, res, next) {
  try {
    const parsedPath = parseBuildRequestPath(req.originalUrl);

    if (!parsedPath) {
      return res.sendStatus(404);
    }

    const build = await ProjectBuild.findOne({
      projectId: parsedPath.projectId,
      ...buildUrlMatchQuery(parsedPath.indexBuildUrl),
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('projectId status')
      .lean();

    if (!build) {
      return res.sendStatus(404);
    }

    const project = await Project.findById(parsedPath.projectId)
      .select('userId isPublished latestPublishedBuildId buildUrl deployUrl previewUrl distUrl')
      .lean();

    if (!project) {
      return res.sendStatus(404);
    }

    if (isProjectBuildExplicitlyPublished(project, build)) {
      req.buildAccess = {
        parsedPath,
        isPublished: true,
        previewToken: '',
      };
      return next();
    }

    const previewCookieName = 'fluid_build_preview';
    const queryToken = typeof req.query.previewToken === 'string' ? req.query.previewToken : '';
    const cookieToken = getCookie(req, previewCookieName);
    const previewToken = queryToken || cookieToken;

    if (verifyBuildPreviewToken(previewToken, parsedPath.projectId, parsedPath.buildKey)) {
      if (queryToken) {
        res.cookie(previewCookieName, queryToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: `/builds/${parsedPath.projectId}/${parsedPath.buildKey}`,
          maxAge: BUILD_PREVIEW_TTL_SECONDS * 1000,
        });
      }
      req.buildAccess = {
        parsedPath,
        isPublished: false,
        previewToken,
      };
      return next();
    }

    const isAdmin = Boolean(process.env.ADMIN_TOKEN) && req.headers['x-admin-token'] === process.env.ADMIN_TOKEN;
    const userId = await getBearerUserId(req);

    if (isAdmin || (userId && String(project.userId) === String(userId))) {
      req.buildAccess = {
        parsedPath,
        isPublished: false,
        previewToken: createBuildPreviewToken(parsedPath.projectId, parsedPath.buildKey),
      };
      return next();
    }

    return res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
}

async function findMongoBuildArtifact(requestPath) {
  const parsedPath = parseBuildRequestPath(requestPath);

  if (!parsedPath) {
    return null;
  }

  const builds = await ProjectBuild.find({
    projectId: parsedPath.projectId,
    ...buildUrlMatchQuery(parsedPath.indexBuildUrl),
  }).sort({
    updatedAt: -1,
    createdAt: -1,
  });

  const logArtifactLookup = (found) => {
    console.info('[build-artifact]', {
      artifactPath: parsedPath.artifactPath,
      candidates: builds.length,
      found,
    });
  };

  const findArtifact = (build) => {
    if (!Array.isArray(build.artifactFiles)) {
      return null;
    }

    return build.artifactFiles.find((file) => {
      const artifactFilePath = file.relativePath || file.path;
      return artifactFilePath === parsedPath.artifactPath;
    });
  };

  for (const build of builds) {
    const artifact = findArtifact(build);

    if (artifact && artifact.content) {
      logArtifactLookup(true);
      return {
        contentType: getArtifactContentType(artifact, parsedPath.artifactPath),
        body: Buffer.from(artifact.content, artifact.encoding || 'base64'),
      };
    }
  }

  if (parsedPath.artifactPath === 'index.html') {
    const htmlBuild = builds.find((build) => build.fullHtml || build.html);

    if (htmlBuild) {
      logArtifactLookup(true);
      return {
        contentType: 'text/html; charset=utf-8',
        body: htmlBuild.fullHtml || htmlBuild.html,
      };
    }
  }

  logArtifactLookup(false);
  return null;
}

async function loadPublishedHtml(project) {
  const latestDoneBuild = await ProjectBuild.findOne({
    projectId: project._id,
    status: 'done',
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  });
  const build = latestDoneBuild || {};
  const inlineHtml =
    build.fullHtml ||
    build.html ||
    project.fullHtml ||
    project.latestFullHtml ||
    project.html ||
    '';
  const buildUrl = build.buildUrl || build.deployUrl || build.previewUrl || build.distUrl || project.buildUrl || '';

  if (inlineHtml) {
    return rewriteBuildAssetPaths(inlineHtml, buildUrl);
  }

  const mongoArtifact = await findMongoBuildArtifact(buildUrl);

  if (mongoArtifact) {
    const artifactHtml = Buffer.isBuffer(mongoArtifact.body)
      ? mongoArtifact.body.toString('utf8')
      : String(mongoArtifact.body || '');

    return rewriteBuildAssetPaths(artifactHtml, buildUrl);
  }

  const indexPath = resolvePublicBuildIndexPath(buildUrl);

  if (!indexPath) {
    return '';
  }

  try {
    const fileHtml = await fs.readFile(indexPath, 'utf8');
    return rewriteBuildAssetPaths(fileHtml, buildUrl);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

// Render encaminha requisições por um proxy; assim req.ip representa o cliente.
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(cors(corsOptions));
app.options(/^\/builds\/.+$/, authorizeBuildAccess, applyBuildArtifactCors, (req, res) => {
  res.sendStatus(204);
});
app.options(/.*/, cors(corsOptions));
app.use(publicAppsOnly);
app.use('/api', apiRateLimit);
app.use('/api/billing', billingRoutes);
app.use(express.json({ limit: '100kb' }));
app.use(
  '/builds',
  authorizeBuildAccess,
  applyBuildArtifactCors,
  serveBuildIndexWithCapabilities,
  serveBuildCodeAssetWithCapabilities,
  express.static(PUBLIC_BUILDS_DIR)
);
app.get(/^\/builds\/.+$/, async (req, res, next) => {
  try {
    const artifact = await findMongoBuildArtifact(req.path);

    if (!artifact) {
      return next();
    }

    if (
      req.buildAccess &&
      req.buildAccess.isPublished !== true &&
      req.buildAccess.previewToken &&
      req.buildAccess.parsedPath.artifactPath === 'index.html' &&
      String(artifact.contentType || '').startsWith('text/html')
    ) {
      const html = Buffer.isBuffer(artifact.body)
        ? artifact.body.toString('utf8')
        : String(artifact.body || '');
      return res
        .set('Content-Type', artifact.contentType)
        .send(injectBuildPreviewTokenIntoHtmlAssets(
          html,
          req.buildAccess.parsedPath,
          req.buildAccess.previewToken
        ));
    }

    if (
      req.buildAccess &&
      req.buildAccess.isPublished !== true &&
      req.buildAccess.previewToken &&
      /\.(?:css|js|mjs)$/.test(req.buildAccess.parsedPath.artifactPath) &&
      /^text\/css|(?:application|text)\/javascript/.test(String(artifact.contentType || ''))
    ) {
      const code = Buffer.isBuffer(artifact.body)
        ? artifact.body.toString('utf8')
        : String(artifact.body || '');
      return res
        .set('Content-Type', artifact.contentType)
        .send(injectBuildPreviewTokenIntoCodeAssets(
          code,
          req.buildAccess.parsedPath,
          req.buildAccess.previewToken
        ));
    }

    return res.set('Content-Type', artifact.contentType).send(artifact.body);
  } catch (error) {
    return next(error);
  }
});
function sendSettingsAccountPage(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  console.log('Serving settings account page backend-save-v2');
  res.sendFile(SETTINGS_ACCOUNT_HTML_PATH);
}

app.get(['/settings/account', '/settings/account/', '/settings/account/index.html'], sendSettingsAccountPage);
app.get('/debug/settings-build', async (req, res, next) => {
  try {
    const html = await fs.readFile(SETTINGS_ACCOUNT_HTML_PATH, 'utf8');
    const oldProfileSavedLocallyText = ['Profile', 'saved', 'locally'].join(' ');
    res.json({
      build: 'backend-save-v2',
      hasOldProfileSavedLocally: html.includes(oldProfileSavedLocallyText),
      file: 'public/settings/account/index.html',
    });
  } catch (error) {
    next(error);
  }
});
app.use(express.static(PUBLIC_DIR));
app.get('/p/:slug', async (req, res) => {
  try {
    const project = await Project.findOne({
      slug: req.params.slug,
      isPublished: true,
    });

    if (!project) {
      return res.status(404).send('Projeto não encontrado.');
    }

    const html = injectPublishedSeo(await loadPublishedHtml(project), project);

    if (!html) {
      return res.status(404).send('Projeto não encontrado.');
    }

    return res.type('html').send(html);
  } catch (error) {
    return res.status(500).send('Erro ao carregar projeto publicado.');
  }
});
app.use('/api/auth/login', loginRateLimit);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chat', chatIpRateLimit, chatRoutes);
app.use('/api/admin', adminRateLimit, adminRoutes);
app.use('/api/connectors', connectorRegistryRoutes);
app.use('/api/runtime/:projectId', runtimeRoutes);
app.use((error, req, res, next) => {
  console.error('Erro não tratado na requisição.', {
    name: error?.name || 'Error',
    code: error?.code || null,
    status: error?.status || error?.statusCode || 500,
  });

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ message: 'Erro interno do servidor.' });
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB conectado');
  })
  .catch((err) => {
    console.error('Erro MongoDB.', { name: err?.name || 'Error', code: err?.code || null });
  });

app.get('/', (req, res) => {
  if (isPublicAppHost(req)) {
    return res.sendStatus(404);
  }

  res.json({
    message: 'FLUIDBE backend rodando',
    database: 'conectada',
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
