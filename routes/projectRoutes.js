const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const BUILD_STATUSES = ['pending', 'in_progress', 'done'];

function normalizeBuildStatus(project) {
  const statusSignals = [
    project.generation_status,
    project.status,
    project.publish === true ? 'done' : '',
    project.deploy?.isPublished === true ? 'done' : '',
  ];

  if (statusSignals.includes('done') || statusSignals.includes('published')) {
    return 'done';
  }

  if (statusSignals.includes('in_progress') || statusSignals.includes('building')) {
    return 'in_progress';
  }

  if (statusSignals.includes('pending') || statusSignals.includes('draft')) {
    return 'pending';
  }

  return BUILD_STATUSES.includes(project.status) ? project.status : 'pending';
}

function buildProjectPayload(projectDocument) {
  const project =
    typeof projectDocument.toObject === 'function'
      ? projectDocument.toObject({ getters: true, virtuals: true })
      : projectDocument;
  const status = normalizeBuildStatus(project);
  const fullHtml = project.fullHtml || project.latestFullHtml || '';
  const build = project.build && typeof project.build === 'object' ? project.build : {};

  return {
    success: true,
    status,
    generation_status: status,
    response: project.response || '',
    summary: project.summary || '',
    html: project.html || '',
    css: project.css || '',
    js: project.js || '',
    fullHtml,
    latestFullHtml: project.latestFullHtml || fullHtml,
    distUrl: project.distUrl || build.distUrl || '',
    previewUrl: project.previewUrl || build.previewUrl || '',
    buildUrl: project.buildUrl || build.buildUrl || '',
    deploy: project.deploy || {},
    reactVite: project.reactVite === true || build.reactVite === true,
    build,
    project,
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.userId }).sort({
      createdAt: -1,
    });

    return res.json(projects);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Nome do projeto é obrigatório.' });
    }

    const project = await Project.create({
  userId: req.userId,
  name,
  description,
  status,
  prompt,
  type,
  settings,
});
    return res.status(201).json({
      message: 'Projeto criado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao criar projeto.',
      error: error.message,
    });
  }
});

router.get('/:id/build', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(buildProjectPayload(project));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar build do projeto.',
      error: error.message,
    });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(project);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projeto.',
      error: error.message,
    });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
      },
      {
        name,
        description,
        status,
        prompt,
        type,
        settings,
        


      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto atualizado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar projeto.',
      error: error.message,
    });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto excluído com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao excluir projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
