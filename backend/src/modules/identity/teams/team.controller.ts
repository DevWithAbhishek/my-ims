import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../auth/guard.js';
import { pageResponse } from '../identity.common.js';
import * as teamService from './team.service.js';
import {
  createTeamBodySchema,
  listTeamsQuerySchema,
  teamParamsSchema,
  updateTeamBodySchema,
} from './team.schema.js';

export const createTeamHandler: RequestHandler = async (req, res) => {
  const body = parseOrThrow(createTeamBodySchema, req.body);
  res.status(201).json({ data: await teamService.createTeam(body.name) });
};

export const listTeamsHandler: RequestHandler = async (req, res) => {
  const query = parseOrThrow(listTeamsQuerySchema, req.query);
  res.status(200).json(pageResponse(await teamService.listTeams(query)));
};

export const getTeamHandler: RequestHandler = async (req, res) => {
  const { teamId } = parseOrThrow(teamParamsSchema, req.params);
  res.status(200).json({ data: await teamService.getTeam(getAuth(req), teamId) });
};

export const updateTeamHandler: RequestHandler = async (req, res) => {
  const { teamId } = parseOrThrow(teamParamsSchema, req.params);
  const body = parseOrThrow(updateTeamBodySchema, req.body);
  res.status(200).json({ data: await teamService.updateTeam(teamId, body) });
};
