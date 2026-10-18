const express = require('express');
const api = require('./routes');
const admin = require('./routes/admin');
const { health } = require('./handlers/health');

const app = express();
app.use(express.json());
app.use('/api', api);
app.use('/backoffice', admin);
app.get('/health', health);

app.listen(3000);
