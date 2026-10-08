// scripts/run-consultation-jobs.js -- one pass of the consultation jobs. Schedule it every few minutes.
require('dotenv').config();
const { runConsultationJobs } = require('../src/lib/consultationJobs');
runConsultationJobs().then((r) => { console.log(JSON.stringify(r)); process.exit(r.failures && r.failures.length ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });
