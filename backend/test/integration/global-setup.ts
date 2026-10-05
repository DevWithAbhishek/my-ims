import { prepareTestDatabase } from '../helpers/db-setup';

export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
