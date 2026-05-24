'use strict';

// API Engine — public surface

const oauth      = require('./oauth/index');
const { publishPost, schedulePost, deletePost } = require('./actions/post');
const { getAnalytics, getFollowers }            = require('./actions/analytics');
const { replyComment }                          = require('./actions/engagement');
const { startRunner }                           = require('./scheduler/runner');
const queue                                     = require('./scheduler/queue');

module.exports = {
  // OAuth
  oauth,
  // Post actions
  publishPost,
  schedulePost,
  deletePost,
  // Analytics
  getAnalytics,
  getFollowers,
  // Engagement
  replyComment,
  // Scheduler
  startRunner,
  queue,
};
