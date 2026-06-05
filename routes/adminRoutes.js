const express = require('express');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');

const router = express.Router();
const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '..');
const REACT_VITE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'react-vite-builds');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');

const WIZARD_STATUSES = ['pending', 'in_progress', 'done'];
const BUILD_FIELDS = [
  'type',
  'status',
  'html',
  'css',
  'js',
  'fullHtml',
  'distUrl',
  'previewUrl',
  'buildUrl',
  'deployUrl',
  'sourceZipUrl',
  'logs',
];

function applyWizardStatus(update, value) {
  update.generationStatus = value;
  update.generation_status = value;
  update.status = value;
}

function applyLoadingStatus(update) {
  applyWizardStatus(update, 'in_progress');
  update.publish = false;
}

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ message: 'Admin não autorizado' });
  }

  return next();
}

function validateProjectId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'ID de projeto inválido.' });
  }

  return next();
}

async function loadProject(req, res, next) {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    req.project = project;
    return next();
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projeto.',
      error: error.message,
    });
  }
}

const reactViteUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, callback) => {
      try {
        const timestamp = String(Date.now());
        const uploadDir = path.join(REACT_VITE_STORAGE_DIR, req.params.id, timestamp);

        req.reactViteBuildTimestamp = timestamp;
        req.reactViteBuildDir = uploadDir;

        await fs.mkdir(uploadDir, { recursive: true });
        callback(null, uploadDir);
      } catch (error) {
        callback(error);
      }
    },
    filename: (req, file, callback) => {
      callback(null, 'source.zip');
    },
  }),
  fileFilter: (req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return callback(new Error('Apenas arquivos .zip são aceitos.'));
    }

    return callback(null, true);
  },
  limits: {
    files: 1,
  },
});

function runReactViteUpload(req, res, next) {
  reactViteUpload.single('file')(req, res, (error) => {
    if (!error) {
      return next();
    }

    return res.status(400).json({
      message: 'Upload inválido.',
      error: error.message,
    });
  });
}

async function extractZipSafely(zipPath, destinationDir) {
  const zip = new AdmZip(zipPath);
  const destinationRoot = path.resolve(destinationDir);

  await fs.mkdir(destinationRoot, { recursive: true });

  for (const entry of zip.getEntries()) {
    const targetPath = path.resolve(destinationRoot, entry.entryName);

    if (targetPath !== destinationRoot && !targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
      throw new Error(`ZIP contém caminho inválido: ${entry.entryName}`);
    }

    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function findReactViteRoot(extractDir) {
  if (await pathExists(path.join(extractDir, 'package.json'))) {
    return extractDir;
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length === 1) {
    const nestedRoot = path.join(extractDir, directories[0].name);

    if (await pathExists(path.join(nestedRoot, 'package.json'))) {
      return nestedRoot;
    }
  }

  for (const directory of directories) {
    const nestedRoot = path.join(extractDir, directory.name);

    if (await pathExists(path.join(nestedRoot, 'package.json'))) {
      return nestedRoot;
    }
  }

  return extractDir;
}

async function validateReactViteProject(appRoot) {
  const requiredPaths = [
    path.join(appRoot, 'package.json'),
    path.join(appRoot, 'index.html'),
    path.join(appRoot, 'src'),
  ];

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`Estrutura React/Vite inválida. Ausente: ${path.basename(requiredPath)}`);
    }
  }

  const srcStats = await fs.stat(path.join(appRoot, 'src'));

  if (!srcStats.isDirectory()) {
    throw new Error('Estrutura React/Vite inválida. src precisa ser uma pasta.');
  }
}

async function runNpmCommand(args, cwd) {
  try {
    const result = await execFileAsync('npm', args, {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  } catch (error) {
    const logs = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(logs || `npm ${args.join(' ')} falhou.`);
  }
}

async function runNpxCommand(args, cwd) {
  try {
    const result = await execFileAsync('npx', args, {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  } catch (error) {
    const logs = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(logs || `npx ${args.join(' ')} falhou.`);
  }
}

async function readPackageJson(appRoot) {
  const packageJsonPath = path.join(appRoot, 'package.json');
  const rawPackageJson = await fs.readFile(packageJsonPath, 'utf8');

  return JSON.parse(rawPackageJson);
}

function buildScriptContainsTscBuild(packageJson) {
  const buildScript = packageJson?.scripts?.build;

  return typeof buildScript === 'string' && buildScript.includes('tsc -b');
}

async function runViteBuildWithoutTypecheck(appRoot) {
  return runNpxCommand(['vite', 'build'], appRoot);
}

async function runFallbackViteBuild(appRoot, precedingLogs = '') {
  const fallbackLog = [precedingLogs, 'Fallback aplicado: npx vite build sem typecheck.']
    .filter(Boolean)
    .join('\n');

  try {
    return [fallbackLog, await runViteBuildWithoutTypecheck(appRoot)].filter(Boolean).join('\n');
  } catch (error) {
    throw new Error([fallbackLog, error.message].filter(Boolean).join('\n'));
  }
}

async function runReactViteBuild(appRoot) {
  const packageJson = await readPackageJson(appRoot);

  if (buildScriptContainsTscBuild(packageJson)) {
    return runFallbackViteBuild(appRoot);
  }

  try {
    return await runNpmCommand(['run', 'build'], appRoot);
  } catch (error) {
    return runFallbackViteBuild(appRoot, error.message);
  }
}

function stripJsonComments(json) {
  let stripped = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    const nextChar = json[index + 1];

    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      while (index < json.length && json[index] !== '\n') {
        index += 1;
      }
      stripped += '\n';
      continue;
    }

    if (char === '/' && nextChar === '*') {
      index += 2;
      while (index < json.length && !(json[index] === '*' && json[index + 1] === '/')) {
        stripped += json[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }

    stripped += char;
  }

  return stripped;
}

function stripJsonTrailingCommas(json) {
  let stripped = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];

    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;

      while (/\s/.test(json[nextIndex] || '')) {
        nextIndex += 1;
      }

      if (json[nextIndex] === '}' || json[nextIndex] === ']') {
        continue;
      }
    }

    stripped += char;
  }

  return stripped;
}

function parseTsconfig(rawConfig) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    return JSON.parse(stripJsonTrailingCommas(stripJsonComments(rawConfig)));
  }
}

async function findTsconfigFiles(rootDir) {
  const matches = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      matches.push(...(await findTsconfigFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && /^tsconfig.*\.json$/i.test(entry.name)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

async function applyTsconfigDeprecationFix(appRoot) {
  const tsconfigFiles = await findTsconfigFiles(appRoot);
  const fixedPaths = [];

  for (const tsconfigPath of tsconfigFiles) {
    const rawConfig = await fs.readFile(tsconfigPath, 'utf8');
    const config = parseTsconfig(rawConfig);

    if (!config.compilerOptions || typeof config.compilerOptions !== 'object') {
      config.compilerOptions = {};
    }

    const compilerOptions = config.compilerOptions;

    if (String(compilerOptions.moduleResolution).toLowerCase() === 'node10') {
      compilerOptions.moduleResolution = 'bundler';
    }

    compilerOptions.ignoreDeprecations = '6.0';

    await fs.writeFile(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    fixedPaths.push(path.relative(appRoot, tsconfigPath));
  }

  return fixedPaths;
}

function applyRelativeViteBase(rawConfig) {
  if (/base\s*:\s*(['"`])\.\/\1/.test(rawConfig)) {
    return rawConfig;
  }

  if (/base\s*:\s*(['"`])[^'"`]*\1/.test(rawConfig)) {
    return rawConfig.replace(/base\s*:\s*(['"`])[^'"`]*\1/, "base: './'");
  }

  if (/defineConfig\s*\(\s*\{/.test(rawConfig)) {
    return rawConfig.replace(/defineConfig\s*\(\s*\{/, "defineConfig({\n  base: './',");
  }

  if (/export\s+default\s+\{/.test(rawConfig)) {
    return rawConfig.replace(/export\s+default\s+\{/, "export default {\n  base: './',");
  }

  return rawConfig;
}

async function ensureViteRelativeBase(appRoot) {
  const viteConfigFiles = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts'];

  for (const filename of viteConfigFiles) {
    const configPath = path.join(appRoot, filename);

    if (!(await pathExists(configPath))) {
      continue;
    }

    const rawConfig = await fs.readFile(configPath, 'utf8');
    const updatedConfig = applyRelativeViteBase(rawConfig);

    if (updatedConfig !== rawConfig) {
      await fs.writeFile(configPath, updatedConfig);
      return filename;
    }

    return null;
  }

  return null;
}

async function fixDistIndexAssetPaths(distDir) {
  const indexPath = path.join(distDir, 'index.html');

  if (!(await pathExists(indexPath))) {
    throw new Error('Build concluído sem gerar dist/index.html.');
  }

  const html = await fs.readFile(indexPath, 'utf8');
  const fixedHtml = html
    .replaceAll('src="/assets/', 'src="./assets/')
    .replaceAll("src='/assets/", "src='./assets/")
    .replaceAll('href="/assets/', 'href="./assets/')
    .replaceAll("href='/assets/", "href='./assets/")
    .replaceAll('url(/assets/', 'url(./assets/')
    .replaceAll('url("/assets/', 'url("./assets/')
    .replaceAll("url('/assets/", "url('./assets/");

  if (fixedHtml !== html) {
    await fs.writeFile(indexPath, fixedHtml);
    return true;
  }

  return false;
}

function pickBuildPayload(body) {
  return BUILD_FIELDS.reduce((payload, field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }

    return payload;
  }, {});
}

router.get('/projects', requireAdmin, async (req, res) => {
  try {
    const projects = await Project.find().sort({
      updatedAt: -1,
      createdAt: -1,
    });

    return res.json({
      success: true,
      projects,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.get('/projects/:id/versions', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const ProjectVersion = mongoose.models.ProjectVersion;

    if (!ProjectVersion) {
      return res.json({
        success: true,
        versions: [],
      });
    }

    const versions = await ProjectVersion.find({ projectId: req.params.id }).sort({
      createdAt: -1,
    });

    return res.json({
      success: true,
      versions,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar versões do projeto.',
      error: error.message,
    });
  }
});

router.post(
  '/projects/:id/react-vite',
  requireAdmin,
  validateProjectId,
  loadProject,
  runReactViteUpload,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: 'Campo file é obrigatório.' });
    }

    const project = req.project;
    const timestamp = req.reactViteBuildTimestamp;
    const buildDir = req.reactViteBuildDir;
    const sourceZipPath = req.file.path;
    const extractDir = path.join(buildDir, 'source');
    let logs = '';

    try {
      await extractZipSafely(sourceZipPath, extractDir);

      const appRoot = await findReactViteRoot(extractDir);
      await validateReactViteProject(appRoot);

      const fixedTsconfigPaths = await applyTsconfigDeprecationFix(appRoot);
      for (const fixedTsconfigPath of fixedTsconfigPaths) {
        logs += `Auto-fix TS5107 aplicado em: ${fixedTsconfigPath}\n`;
      }

      const viteConfigFixed = await ensureViteRelativeBase(appRoot);
      if (viteConfigFixed) {
        logs += `Auto-fix aplicado: base './' em ${viteConfigFixed}.\n`;
      }

      logs += await runNpmCommand(['install'], appRoot);
      logs += '\n';

      logs += await runNpmCommand(['install', 'react', 'react-dom'], appRoot);
      logs += '\n';

      logs += await runNpmCommand(
        ['install', '-D', 'vite', '@vitejs/plugin-react', 'typescript', '@types/react', '@types/react-dom'],
        appRoot
      );
      logs += '\n';

      logs += await runReactViteBuild(appRoot);

      const distDir = path.join(appRoot, 'dist');

      if (!(await pathExists(distDir))) {
        throw new Error('Build concluído sem gerar a pasta dist.');
      }

      if (await fixDistIndexAssetPaths(distDir)) {
        logs += '\nAuto-fix aplicado: caminhos /assets/ corrigidos em dist/index.html.\n';
      }

      const publicBuildDir = path.join(PUBLIC_BUILDS_DIR, String(project._id), timestamp);
      await fs.mkdir(publicBuildDir, { recursive: true });
      await fs.cp(distDir, publicBuildDir, { recursive: true });

      const previewUrl = `/builds/${project._id}/${timestamp}/index.html`;
      const build = await ProjectBuild.create({
        projectId: project._id,
        type: 'react_vite',
        status: 'draft',
        distUrl: previewUrl,
        previewUrl,
        buildUrl: previewUrl,
        deployUrl: previewUrl,
        sourceZipUrl: '',
        logs: [logs, 'React/Vite build concluído com sucesso.'].filter(Boolean).join('\n'),
      });

      await Project.findByIdAndUpdate(
        project._id,
        {
          status: 'in_progress',
          generation_status: 'in_progress',
          generationStatus: 'in_progress',
          reactVite: true,
          'metadata.lastBuildAt': new Date(),
        },
        {
          runValidators: true,
        }
      );

      return res.status(201).json({
        success: true,
        build,
        previewUrl,
      });
    } catch (error) {
      const errorLogs = [logs, error.message].filter(Boolean).join('\n');
      const build = await ProjectBuild.create({
        projectId: project._id,
        type: 'react_vite',
        status: 'failed',
        logs: errorLogs,
      });

      return res.status(500).json({
        success: false,
        message: 'Erro ao gerar build React/Vite.',
        build,
        error: error.message,
      });
    }
  }
);

router.post('/projects/:id/builds', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const build = await ProjectBuild.create({
      projectId: project._id,
      ...pickBuildPayload(req.body),
    });

    return res.status(201).json({
      success: true,
      build,
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Build inválido.',
        error: error.message,
      });
    }

    return res.status(500).json({
      message: 'Erro ao criar build do projeto.',
      error: error.message,
    });
  }
});

router.get('/projects/:id/builds', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const builds = await ProjectBuild.find({ projectId: project._id }).sort({
      createdAt: -1,
      updatedAt: -1,
    });

    return res.json({
      success: true,
      builds,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar builds do projeto.',
      error: error.message,
    });
  }
});

router.patch('/projects/:id/manual', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const existingProject = await Project.findById(req.params.id);

    if (!existingProject) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const {
      title,
      response,
      html,
      css,
      js,
      fullHtml,
      latestFullHtml,
      summary,
      generationStatus,
      generation_status: generationStatusSnake,
      status,
      publish,
      distUrl,
      previewUrl,
      buildUrl,
      deploy,
      reactVite,
      build,
    } = req.body;
    const update = {};
    const setIfDefined = (field, value) => {
      if (value !== undefined) {
        update[field] = value;
      }
    };

    if (title !== undefined) {
      update.title = title;
      update.name = title;
    }

    setIfDefined('response', response);
    setIfDefined('html', html);
    setIfDefined('css', css);
    setIfDefined('js', js);
    setIfDefined('fullHtml', fullHtml);
    setIfDefined('latestFullHtml', latestFullHtml !== undefined ? latestFullHtml : fullHtml);
    setIfDefined('summary', summary);
    setIfDefined('distUrl', distUrl);
    setIfDefined('previewUrl', previewUrl);
    setIfDefined('buildUrl', buildUrl);
    setIfDefined('deploy', deploy);
    setIfDefined('reactVite', reactVite);
    setIfDefined('build', build);

    const requestedStatus =
      generationStatus !== undefined
        ? generationStatus
        : generationStatusSnake !== undefined
          ? generationStatusSnake
          : status;

    if (requestedStatus !== undefined) {
      if (!WIZARD_STATUSES.includes(requestedStatus)) {
        return res.status(400).json({
          message: 'Status inválido.',
          allowedStatuses: WIZARD_STATUSES,
        });
      }

      if (requestedStatus === 'in_progress') {
        applyLoadingStatus(update);
      } else {
        applyWizardStatus(update, requestedStatus);
      }
    }

    if (publish !== undefined) {
      update.publish = publish === true;

      if (publish === true) {
        const latestPendingBuild = await ProjectBuild.findOne({
          projectId: req.params.id,
          status: { $in: ['draft', 'in_progress'] },
        }).sort({
          createdAt: -1,
          updatedAt: -1,
        });

        if (latestPendingBuild) {
          latestPendingBuild.status = 'done';
          await latestPendingBuild.save();
          const publishedBuild = latestPendingBuild.toObject({
            getters: true,
            virtuals: true,
          });

          update.reactVite = latestPendingBuild.type === 'react_vite';
          update.build = publishedBuild;
          update.distUrl = latestPendingBuild.distUrl || '';
          update.previewUrl = latestPendingBuild.previewUrl || '';
          update.buildUrl =
            latestPendingBuild.buildUrl ||
            latestPendingBuild.deployUrl ||
            latestPendingBuild.previewUrl ||
            latestPendingBuild.distUrl ||
            '';

          if (latestPendingBuild.deployUrl) {
            update['deploy.url'] = latestPendingBuild.deployUrl;
          }
        }

        applyWizardStatus(update, 'done');
        update['deploy.isPublished'] = true;
        update['deploy.publishedAt'] = new Date();
        update['metadata.lastBuildAt'] = new Date();
      }
    }

    const project = await Project.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar projeto manualmente.',
      error: error.message,
    });
  }
});

router.patch('/projects/:id/status', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const { generationStatus, generation_status: generationStatusSnake, status } = req.body;
    const requestedStatus =
      generationStatus !== undefined
        ? generationStatus
        : generationStatusSnake !== undefined
          ? generationStatusSnake
          : status;

    if (!WIZARD_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({
        message: 'Status inválido.',
        allowedStatuses: WIZARD_STATUSES,
      });
    }

    const update = {};

    if (requestedStatus === 'in_progress') {
      applyLoadingStatus(update);
    } else {
      applyWizardStatus(update, requestedStatus);
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      update,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar status do projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
