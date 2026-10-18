const users = [];

function listUsers(req, res) {
  res.json(users);
}

function getUser(req, res) {
  res.json(users.find((u) => u.id === req.params.id));
}

function saveAvatar(id, data) {
  return { id, data };
}

module.exports = { listUsers, getUser, saveAvatar };
