const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

function getProjectStatus(project) {
  return project.generation_status || project.status || 'pending';
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

    const status = getProjectStatus(project);
    const buildStatus = {
      success: true,
      status,
      generation_status: project.generation_status,
      project,
    };

    if (status !== 'done') {
      return res.json(buildStatus);
    }

    return res.json({
      ...buildStatus,
      html: project.html || '',
      css: project.css || '',
      js: project.js || '',
      response: project.response || '',
      summary: project.summary || '',
      project,
    });
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
