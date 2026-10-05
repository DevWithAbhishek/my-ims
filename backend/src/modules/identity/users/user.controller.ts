import type { RequestHandler } from 'express';
import { parseOrThrow } from '../../../shared/errors/zod.js';
import { getAuth } from '../auth/guard.js';
import { pageResponse } from '../identity.common.js';
import * as userService from './user.service.js';
import {
  createUserBodySchema,
  listUsersQuerySchema,
  teamUsersParamsSchema,
  updateUserBodySchema,
  userParamsSchema,
} from './user.schema.js';

export const createUserHandler: RequestHandler = async (req, res) => {
  const body = parseOrThrow(createUserBodySchema, req.body);
  res.status(201).json({ data: await userService.createUser(body) });
};

export const listTeamUsersHandler: RequestHandler = async (req, res) => {
  const { teamId } = parseOrThrow(teamUsersParamsSchema, req.params);
  const query = parseOrThrow(listUsersQuerySchema, req.query);
  res.status(200).json(pageResponse(await userService.listTeamUsers(getAuth(req), teamId, query)));
};

export const getUserHandler: RequestHandler = async (req, res) => {
  const { userId } = parseOrThrow(userParamsSchema, req.params);
  res.status(200).json({ data: await userService.getUser(getAuth(req), userId) });
};

export const updateUserHandler: RequestHandler = async (req, res) => {
  const { userId } = parseOrThrow(userParamsSchema, req.params);
  const body = parseOrThrow(updateUserBodySchema, req.body);
  res.status(200).json({ data: await userService.updateUser(userId, body) });
};
