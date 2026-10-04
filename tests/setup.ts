import 'dotenv/config';

// Point the app's pool at the test database before any app module loads config.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://sneak:sneak@localhost:5433/sneakdrop_test';
