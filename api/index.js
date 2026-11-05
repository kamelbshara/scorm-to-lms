import { database, migrate } from '../db.js';
import { createApp } from '../server.js';

// Cache initialization within each warm function instance; retry failed cold starts.
export function handlerFor({ connect = () => database(process.env.DATABASE_URL), appOptions = {} } = {}) {
  let ready;
  return async (req, res) => {
    try {
      ready ??= (async () => {
        const db = connect();
        await migrate(db);
        return createApp(db, appOptions);
      })().catch(error => { ready = undefined; throw error; });
      const app = await ready;
      return app(req, res);
    } catch (error) {
      console.error('Application initialization failed:', error.code || error.name);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Application unavailable; check server environment settings' }));
    }
  };
}
export default handlerFor();
