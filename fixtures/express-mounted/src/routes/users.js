const express = require('express');
const { listUsers, getUser, saveAvatar } = require('../handlers/users');

const router = express.Router();
router.get('/', listUsers);
router.get('/:id', getUser);
router
  .route('/:id/avatar')
  .get(getUser)
  .put((req, res) => {
    saveAvatar(req.params.id, req.body);
    res.end();
  });

module.exports = router;
