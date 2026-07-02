import { Router } from 'express';
import * as projectService from '../services/projectService.js';
import type { CreateProjectBody, UpdateProjectBody } from '../types/index.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const projects = await projectService.listProjects();
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body as CreateProjectBody;
    const project = await projectService.createProject(body);
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await projectService.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const updates = req.body as UpdateProjectBody;
    const project = await projectService.updateProject(req.params.id, updates);
    res.json(project);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const body = req.body as { title?: string };
    const project = await projectService.createProject({
      title: body.title,
      duplicateFrom: req.params.id,
    });
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await projectService.deleteProject(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
