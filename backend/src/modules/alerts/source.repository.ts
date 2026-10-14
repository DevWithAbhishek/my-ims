import { getPrisma } from '../../infra/db/prisma.js';

export type AlertSourceRecord = {
  id: string;
  name: string;
  sourceType: string;
  status: 'ACTIVE' | 'DEACTIVATED';
  configuration: unknown;
};

export function findAlertSourceById(id: string): Promise<AlertSourceRecord | null> {
  return getPrisma().alertSource.findUnique({
    where: { id },
    select: { id: true, name: true, sourceType: true, status: true, configuration: true },
  });
}
