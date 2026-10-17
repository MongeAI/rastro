const express = require('express');
const { listUsers, getUser, createUser } = require('./handlers/users');

const app = express();
app.use(express.json());

app.get('/users', listUsers);
app.get('/users/:id', getUser);
app.post('/users', (req, res) => {
  res.status(201).json(createUser(req.body));
});
app.delete('/users/:id', removeUser);

app.listen(3000);
