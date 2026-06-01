'use strict';

const crypto = require('crypto');
const { makeLogger } = require('../../utils/logger');
const h = require('../human');

const log = makeLogger('Instagram');

const BASE_URL = 'https://www.instagram.com';

// ----------------------------------------------------------------
// Selector registry — centralized for easy updates when IG changes DOM
// ----------------------------------------------------------------

const SEL = {
  // Login
  username_input:     'input[name="username"]',
  password_input:     'input[name="password"]',
  login_button:       'button[type="submit"]',
  two_fa_input:       'input[name="verificationCode"], input[aria-label*="Security code"], input[aria-label*="Confirmation code"]',
  two_fa_submit:      'button[type="submit"], button:has-text("Confirm")',
  save_info_not_now:  'button:has-text("Not Now"), div[role="button"]:has-text("Not Now")',
  notif_not_now:      'button:has-text("Not Now"), button:has-text("Allow")',

  // Feed
  article:            'article[role="presentation"]',
  like_button:        'svg[aria-label="Like"], [aria-label="Like"][role="button"]',
  unlike_button:      'svg[aria-label="Unlike"], [aria-label="Unlike"][role="button"]',

  // Create post / Reel / Story
  create_btn:         'svg[aria-label="New post"], a[href="/create/style/"]',
  post_file_input:    'input[type="file"][accept*="video"], input[type="file"]',
  // Upload wizard steps
  next_button:        'div[role="button"]:has-text("Next"), button:has-text("Next")',
  share_button:       'div[role="button"]:has-text("Share"), button:has-text("Share")',
  caption_input:      'div[aria-label="Write a caption…"], div[role="textbox"][aria-label*="caption"]',
  // Reel-specific: "Remix off", crop controls shown — skip with Next
  reel_next:          'div[role="button"]:has-text("Next")',
  comment_button:     'svg[aria-label="Comment"], [aria-label="Comment"][role="button"]',
  comment_textarea:   'textarea[aria-label="Add a comment…"], textarea[placeholder*="Add a comment"], div[aria-label*="Add a comment"][role="textbox"]',
  comment_submit:     'div[role="button"]:has-text("Post"), button:has-text("Post")',

  // Profile
  follow_button:      'button._acan._acap._acat._acaw, header button:has-text("Follow"):not(:has-text("Following")), header button._acan',
  following_button:   'button:has-text("Following"), button[aria-label="Following"]',
  unfollow_confirm:   'button:has-text("Unfollow"):not(:has-text("Following"))',

  // Story
  story_close:        'button[aria-label="Close"]',
  story_next:         'button[aria-label="Next"], div[role="button"][aria-label="Next"]',
  story_progress:     'div[style*="animation-duration"]',

  // Reel / video
  reel_mute_button:   'button[aria-label="Audio is muted"], button[aria-label="Mute"]',

  // OAuth
  facebook_oauth_btn: 'a:has-text("Log in with Facebook"), [data-testid="royal_login_button"], a[href*="facebook.com/dialog"]',

  // DM
  dm_new_msg_btn:     'a[href="/direct/new/"], svg[aria-label="New message"]',
  dm_search_input:    'input[name="queryBox"], input[placeholder*="Search"]',
  dm_user_result:     'div[role="button"]:has-text("{{username}}")',
  dm_next_button:     'div[role="button"]:has-text("Next"), button:has-text("Next")',
  dm_message_input:   'div[aria-label="Message"][role="textbox"], div[contenteditable="true"][role="textbox"]',
  dm_send_button:     'button:has-text("Send"), div[role="button"]:has-text("Send")',
};

// ----------------------------------------------------------------
// TOTP generator (RFC 6238) — no external dep
// ----------------------------------------------------------------

function generateTOTP(base32Secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.replace(/[\s=]/g, '').toUpperCase();

  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, '0');
  }

  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  const time = BigInt(Math.floor(Date.now() / 30000));
  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigInt64BE(time);

  const hmac   = crypto.createHmac('sha1', bytes);
  const digest = hmac.update(timeBuf).digest();
  const offset = digest[19] & 0x0f;

  const code = ((digest[offset]     & 0x7f) << 24) |
               ((digest[offset + 1] & 0xff) << 16) |
               ((digest[offset + 2] & 0xff) <<  8) |
                (digest[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

// ----------------------------------------------------------------
// Detection helper — check page for challenge/block signals
// ----------------------------------------------------------------

async function checkForDetection(page) {
  const url  = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  if (url.includes('/challenge') || url.includes('/accounts/suspended')) {
    return 'challenge';
  }
  if (text.includes('Action Blocked') || text.includes('action has been blocked')) {
    return 'action_block';
  }
  if (text.includes('Try Again Later') || text.includes('feedback?')) {
    return 'action_block';
  }
  if (text.includes('suspicious login') || text.includes('Unusual Login Attempt')) {
    return 'challenge';
  }
  if (url.includes('/accounts/disabled')) {
    return 'disabled';
  }
  return null;
}

// ----------------------------------------------------------------
// 1a. loginWithFacebook — OAuth via Facebook
// ----------------------------------------------------------------

async function loginWithFacebook(page, account) {
  log.info('Logging in via Facebook OAuth', { username: account.username });

  await page.goto(`${BASE_URL}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  const acceptCookies = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept all")').first();
  if (await acceptCookies.count() > 0) { await acceptCookies.click(); await h.shortPause(); }

  const fbBtn = page.locator(SEL.facebook_oauth_btn).first();
  if (await fbBtn.count() === 0) return { success: false, event: 'login_required', message: 'Facebook login button not found' };

  // Facebook OAuth can open as popup or same-tab redirect — handle both
  const popupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
  await fbBtn.click();
  const popup = await popupPromise;

  const authPage = popup ?? page;
  await authPage.waitForLoadState('domcontentloaded').catch(() => {});
  await h.delay(h.randInt(1500, 2500));

  // Fill Facebook credentials
  const emailField = await authPage.$('input[id="email"], input[name="email"]');
  if (emailField) {
    await h.humanType(authPage, 'input[id="email"], input[name="email"]', account.email ?? account.username);
    await h.delay(h.randInt(500, 900));
    await h.humanType(authPage, 'input[id="pass"], input[name="pass"], input[type="password"]', account.password);
    await h.delay(h.randInt(600, 1000));
    const loginBtn = authPage.locator('button[name="login"], [data-testid="royal_login_button"]').first();
    if (await loginBtn.count() > 0) await loginBtn.click();
    else await authPage.keyboard.press('Enter');
    await h.waitForLoad(authPage, 20000);
  }

  // "Continue as" confirmation
  const continueBtn = authPage.locator('button:has-text("Continue"), button:has-text("OK"), button:has-text("Okay")').first();
  if (await continueBtn.count() > 0) {
    await h.delay(h.randInt(800, 1500));
    await continueBtn.click();
    await h.waitForLoad(authPage, 15000);
  }

  if (popup) {
    await popup.waitForEvent('close', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await h.delay(h.randInt(1000, 2000));
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  const url = page.url();
  if (url.includes('/accounts/login') || url.includes('/challenge')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Facebook OAuth login successful', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 1. login
// ----------------------------------------------------------------

async function login(page, account) {
  if (account.login_method === 'facebook') return loginWithFacebook(page, account);
  // default: username/password
  log.info('Logging in', { username: account.username });

  await page.goto(`${BASE_URL}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Accept cookies if prompted
  const acceptCookies = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept all")').first();
  if (await acceptCookies.count() > 0) {
    await acceptCookies.click();
    await h.shortPause();
  }

  await h.humanType(page, SEL.username_input, account.username);
  await h.delay(h.randInt(400, 900));
  await h.humanType(page, SEL.password_input, account.password);
  await h.delay(h.randInt(600, 1200));
  await h.humanClick(page, SEL.login_button);
  await h.waitForLoad(page, 20000);

  // Handle 2FA
  const twoFaField = await page.$(SEL.two_fa_input);
  if (twoFaField) {
    if (!account.two_fa_secret) throw new Error('2FA required but no two_fa_secret set for account');
    log.info('Handling 2FA', { username: account.username });
    const otp = generateTOTP(account.two_fa_secret);
    await h.preAction();
    await h.humanType(page, SEL.two_fa_input, otp);
    await h.delay(h.randInt(500, 1000));
    await h.humanClick(page, SEL.two_fa_submit);
    await h.waitForLoad(page, 15000);
  }

  // Dismiss "Save your login info?" dialog
  const saveInfoBtn = page.locator(SEL.save_info_not_now).first();
  if (await saveInfoBtn.count() > 0) {
    await h.delay(h.randInt(1000, 2000));
    await saveInfoBtn.click();
    await h.shortPause();
  }

  // Dismiss notifications prompt
  const notifBtn = page.locator(SEL.notif_not_now).first();
  if (await notifBtn.count() > 0) {
    await h.delay(h.randInt(800, 1500));
    await notifBtn.click();
    await h.shortPause();
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Verify logged in
  const currentUrl = page.url();
  if (currentUrl.includes('/accounts/login')) {
    return { success: false, event: 'login_required' };
  }

  log.info('Login successful', { username: account.username });
  return { success: true };
}

// ----------------------------------------------------------------
// 2. scrollFeed — scroll the home feed naturally
// ----------------------------------------------------------------

async function scrollFeed(page, { seconds = null } = {}) {
  const duration = seconds ?? h.randInt(30, 120);
  log.debug('Scrolling feed', { duration });

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const start = Date.now();
  while (Date.now() - start < duration * 1000) {
    await h.humanScroll(page, { scrolls: h.randInt(2, 5) });
    await h.delay(h.randInt(1500, 4000));
  }

  return { success: true };
}

// ----------------------------------------------------------------
// 3. watchStory — view a user's story naturally
// ----------------------------------------------------------------

async function watchStory(page, username) {
  log.debug('Watching story', { username });

  await page.goto(`${BASE_URL}/stories/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Tap through 1–5 story frames
  const frames = h.randInt(1, 5);
  for (let i = 0; i < frames; i++) {
    // Watch for randInt(3, 12) seconds per frame
    await h.delay(h.randInt(3000, 12000));

    const nextBtn = page.locator(SEL.story_next).first();
    if (await nextBtn.count() === 0) break;

    const detection2 = await checkForDetection(page);
    if (detection2) return { success: false, event: detection2 };

    await nextBtn.click().catch(() => {});
    await h.shortPause();
  }

  log.debug('Story viewed', { username, frames });
  return { success: true };
}

// ----------------------------------------------------------------
// 4. likePost — navigate to post URL and like it
// ----------------------------------------------------------------

async function likePost(page, postUrl) {
  log.debug('Liking post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Check already liked
  const unlike = await page.$(SEL.unlike_button);
  if (unlike) {
    log.debug('Post already liked', { postUrl });
    return { success: true, alreadyLiked: true };
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  await h.humanClick(page, SEL.like_button);
  await h.delay(h.randInt(500, 1200));

  // Verify like registered
  const isLiked = await page.$(SEL.unlike_button);
  if (!isLiked) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
    return { success: false, event: 'action_block' };
  }

  log.debug('Post liked', { postUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 5. followUser
// ----------------------------------------------------------------

async function followUser(page, username) {
  log.debug('Following user', { username });

  await page.goto(`${BASE_URL}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  // Already following?
  const alreadyFollowing = await page.$(SEL.following_button);
  if (alreadyFollowing) {
    log.debug('Already following', { username });
    return { success: true, alreadyFollowing: true };
  }

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Instagram follow button selector is notoriously unstable — try multiple
  const followBtn = page.locator('header button').filter({ hasText: /^Follow$/ }).first();
  if (await followBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Follow button not found' };
  }

  await h.scrollToElementHandle(page, await followBtn.elementHandle());
  await h.preAction();
  await followBtn.click();
  await h.delay(h.randInt(800, 1500));

  // Verify
  const nowFollowing = await page.$(SEL.following_button);
  if (!nowFollowing) {
    const d2 = await checkForDetection(page);
    if (d2) return { success: false, event: d2 };
    return { success: false, event: 'warning', message: 'Follow may not have registered' };
  }

  log.debug('Follow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 6. unfollowUser
// ----------------------------------------------------------------

async function unfollowUser(page, username) {
  log.debug('Unfollowing user', { username });

  await page.goto(`${BASE_URL}/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const followingBtn = await page.$(SEL.following_button);
  if (!followingBtn) {
    log.debug('Not following', { username });
    return { success: true, notFollowing: true };
  }

  await h.scrollToElementHandle(page, followingBtn);
  await h.shortPause();
  await followingBtn.click();
  await h.delay(h.randInt(600, 1200));

  // Confirm unfollow in the dialog
  const confirmBtn = page.locator(SEL.unfollow_confirm).first();
  if (await confirmBtn.count() > 0) {
    await h.delay(h.randInt(400, 900));
    await confirmBtn.click();
    await h.delay(h.randInt(500, 1000));
  }

  log.debug('Unfollow successful', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 7. commentPost
// ----------------------------------------------------------------

async function commentPost(page, postUrl, text) {
  log.debug('Commenting on post', { postUrl });

  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Open comment box
  const commentBtn = page.locator(SEL.comment_button).first();
  if (await commentBtn.count() > 0) {
    await h.scrollToElementHandle(page, await commentBtn.elementHandle());
    await commentBtn.click();
    await h.shortPause();
  }

  const textarea = page.locator(SEL.comment_textarea).first();
  if (await textarea.count() === 0) {
    return { success: false, event: 'warning', message: 'Comment textarea not found' };
  }

  await textarea.click();
  await h.shortPause();

  for (const char of text) {
    await page.keyboard.type(char);
    await h.typingPause();
  }

  await h.delay(h.randInt(500, 1200));

  const submitBtn = page.locator(SEL.comment_submit).first();
  if (await submitBtn.count() === 0) {
    // Fallback: press Enter
    await page.keyboard.press('Enter');
  } else {
    await submitBtn.click();
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Comment posted', { postUrl });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 8. watchReel
// ----------------------------------------------------------------

async function watchReel(page, reelUrl, { referer = null } = {}) {
  log.debug('Watching reel', { reelUrl });

  const gotoOpts = { waitUntil: 'domcontentloaded', timeout: 20000 };
  if (referer) gotoOpts.referer = referer;
  await page.goto(reelUrl, gotoOpts);
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Watch for 15–60% of a typical 30s reel
  const watchMs = h.randInt(8000, 22000);
  await h.delay(watchMs);

  // Scroll a bit (natural behavior)
  if (Math.random() < 0.4) {
    await h.humanScroll(page, { scrolls: h.randInt(1, 3) });
  }

  log.debug('Reel watched', { reelUrl, watchMs });
  return { success: true };
}

// ----------------------------------------------------------------
// 9. sendDM
// ----------------------------------------------------------------

async function sendDM(page, username, message) {
  log.debug('Sending DM', { username });

  await page.goto(`${BASE_URL}/direct/new/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Search for recipient
  const searchInput = page.locator(SEL.dm_search_input).first();
  if (await searchInput.count() === 0) {
    return { success: false, event: 'warning', message: 'DM search input not found' };
  }

  await searchInput.click();
  await h.shortPause();

  for (const char of username) {
    await page.keyboard.type(char);
    await h.typingPause();
  }

  await h.delay(h.randInt(1200, 2500));

  // Click the search result
  const userResult = page.locator(`div[role="button"]:has-text("${username}"), span:has-text("${username}")`).first();
  if (await userResult.count() === 0) {
    return { success: false, event: 'warning', message: `User result not found: ${username}` };
  }

  await userResult.click();
  await h.delay(h.randInt(600, 1200));

  // Click Next
  const nextBtn = page.locator(SEL.dm_next_button).first();
  if (await nextBtn.count() > 0) {
    await nextBtn.click();
    await h.delay(h.randInt(800, 1500));
  }

  // Type message
  const msgInput = page.locator(SEL.dm_message_input).first();
  if (await msgInput.count() === 0) {
    return { success: false, event: 'warning', message: 'DM message input not found' };
  }

  await msgInput.click();
  await h.shortPause();

  for (const char of message) {
    await page.keyboard.type(char);
    await h.typingPause();
  }

  await h.delay(h.randInt(800, 1500));

  // Send
  const sendBtn = page.locator(SEL.dm_send_button).first();
  if (await sendBtn.count() > 0) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await h.delay(h.randInt(1000, 2000));

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('DM sent', { username });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 10. postReel — upload a Reel via browser (videoPath = local file)
// ----------------------------------------------------------------

async function postReel(page, { videoPath, caption = '', hashtags = [] } = {}) {
  if (!videoPath) return { success: false, error: 'videoPath required' };
  log.debug('Posting reel', { videoPath });

  await page.goto(`${BASE_URL}/reels/create/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Trigger file chooser and upload video
  const [fileChooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10000 }),
    page.locator(SEL.post_file_input).first().click().catch(async () => {
      // Fallback: click the create (+) button to open upload dialog
      await h.humanClick(page, SEL.create_btn);
    }),
  ]);
  await fileChooser.setFiles(videoPath);
  await h.waitForLoad(page, 15000);
  await h.delay(h.randInt(2000, 4000)); // wait for video to process

  // Click through the upload wizard (crop → trim → cover → caption)
  for (let step = 0; step < 3; step++) {
    const nextBtn = page.locator(SEL.next_button).first();
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await h.delay(h.randInt(1200, 2500));
    }
  }

  // Write caption + hashtags
  const fullCaption = [caption, hashtags.map(t => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
  if (fullCaption) {
    const captionBox = page.locator(SEL.caption_input).first();
    if (await captionBox.count() > 0) {
      await captionBox.click();
      await h.shortPause();
      for (const char of fullCaption) {
        await page.keyboard.type(char);
        await h.typingPause();
      }
      await h.delay(h.randInt(500, 1000));
    }
  }

  // Share
  const shareBtn = page.locator(SEL.share_button).first();
  if (await shareBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Share button not found' };
  }
  await shareBtn.click();
  await h.waitForLoad(page, 30000); // upload can take time

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Reel posted', { videoPath });
  await h.postAction();
  return { success: true };
}

// ----------------------------------------------------------------
// 11. postStory — upload a Story via browser (mediaPath = local file)
// ----------------------------------------------------------------

async function postStory(page, { mediaPath } = {}) {
  if (!mediaPath) return { success: false, error: 'mediaPath required' };
  log.debug('Posting story', { mediaPath });

  await page.goto(`${BASE_URL}/stories/create/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await h.waitForLoad(page);
  await h.preAction();

  const detection = await checkForDetection(page);
  if (detection) return { success: false, event: detection };

  // Upload file via file input or drag-and-drop zone
  const [fileChooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10000 }),
    page.locator(SEL.post_file_input).first().click().catch(async () => {
      await h.humanClick(page, SEL.create_btn);
    }),
  ]);
  await fileChooser.setFiles(mediaPath);
  await h.waitForLoad(page, 10000);
  await h.delay(h.randInt(1500, 3000));

  // Share to story
  const shareBtn = page.locator(SEL.share_button).first();
  if (await shareBtn.count() === 0) {
    return { success: false, event: 'warning', message: 'Share button not found' };
  }
  await shareBtn.click();
  await h.waitForLoad(page, 20000);

  const d2 = await checkForDetection(page);
  if (d2) return { success: false, event: d2 };

  log.debug('Story posted', { mediaPath });
  await h.postAction();
  return { success: true };
}

module.exports = {
  login,
  loginWithFacebook,
  scrollFeed,
  watchStory,
  likePost,
  followUser,
  unfollowUser,
  commentPost,
  watchReel,
  sendDM,
  postReel,
  postStory,
  checkForDetection,
  generateTOTP,
};
