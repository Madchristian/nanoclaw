/**
 * NanoClaw Dashboard — Local web UI for secure communication and management.
 * Binds to localhost only (no auth needed).
 *
 * Features:
 * - Chat interface (send messages to groups, view history)
 * - Task management (view, pause, resume, cancel scheduled tasks)
 * - Group management (registered groups, status)
 * - Trust management (view/edit trusted users)
 * - Container status & logs
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRecentTaskRuns,
  getTaskById,
  deleteTask,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_STATIC = path.resolve(__dirname, '..', 'dashboard', 'static');

export interface DashboardDeps {
  groupQueue: GroupQueue;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export function startDashboard(port: number, deps: DashboardDeps): void {
  const app = express();
  app.use(express.json());

  // Serve static files
  app.use(express.static(DASHBOARD_STATIC));

  // --- API Routes ---

  // Get all registered groups with their status
  app.get('/api/groups', (_req, res) => {
    try {
      const groups = getAllRegisteredGroups();
      const sessions = getAllSessions();
      const result = Object.entries(groups).map(([jid, group]) => ({
        jid,
        ...group,
        sessionId: sessions[group.folder] || null,
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get all chats (registered + discovered)
  app.get('/api/chats', (_req, res) => {
    try {
      res.json(getAllChats());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get messages for a group
  app.get('/api/messages/:jid', (req, res) => {
    try {
      const jid = decodeURIComponent(req.params.jid);
      const since = (req.query.since as string) || '1970-01-01T00:00:00.000Z';
      const messages = getMessagesSince(jid, since, '');
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Send a message to a group
  app.post('/api/messages/:jid', async (req, res) => {
    try {
      const jid = decodeURIComponent(req.params.jid);
      const { text } = req.body;
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      await deps.sendMessage(jid, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get all scheduled tasks
  app.get('/api/tasks', (_req, res) => {
    try {
      const tasks = getAllTasks();
      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get task run logs
  app.get('/api/tasks/:id/logs', (req, res) => {
    try {
      const logs = getRecentTaskRuns(req.params.id, 20);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Pause/resume/cancel a task
  app.post('/api/tasks/:id/:action', (req, res) => {
    try {
      const { id, action } = req.params;
      const task = getTaskById(id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      switch (action) {
        case 'pause':
          updateTask(id, { status: 'paused' });
          break;
        case 'resume':
          updateTask(id, { status: 'active' });
          break;
        case 'delete':
          deleteTask(id);
          break;
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
          return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get trusted users config
  app.get('/api/trust', (_req, res) => {
    try {
      const homeDir = process.env.HOME || '/Users/user';
      const trustFile = path.join(homeDir, '.config', 'nanoclaw', 'trusted-users.json');
      if (!fs.existsSync(trustFile)) {
        res.json({ users: [] });
        return;
      }
      const config = JSON.parse(fs.readFileSync(trustFile, 'utf-8'));
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Update trusted users config
  app.put('/api/trust', (req, res) => {
    try {
      const homeDir = process.env.HOME || '/Users/user';
      const trustFile = path.join(homeDir, '.config', 'nanoclaw', 'trusted-users.json');
      const configDir = path.dirname(trustFile);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(trustFile, JSON.stringify(req.body, null, 2) + '\n');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get container logs for a group
  app.get('/api/logs/:folder', (req, res) => {
    try {
      const logsDir = path.join(GROUPS_DIR, req.params.folder, 'logs');
      if (!fs.existsSync(logsDir)) {
        res.json([]);
        return;
      }
      const files = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 20);
      const logs = files.map(f => ({
        name: f,
        content: fs.readFileSync(path.join(logsDir, f), 'utf-8').slice(0, 10000),
      }));
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DASHBOARD_STATIC, 'index.html'));
  });

  app.listen(port, '127.0.0.1', () => {
    logger.info({ port }, `Dashboard running at http://localhost:${port}`);
  });
}
