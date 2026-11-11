const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Customer = require("../models/Customer");
const bcrypt = require("bcryptjs");
const Otp = require("../models/Otp");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { hashForSearch } = require("../utils/encryption");
const { resolveMembership } = require("../utils/resolveMembership");
const { otpVerificationHtml, passwordResetHtml } = require("../utils/email-template/otpEmailTemplate");
const { getRawEmail, getRawName } = require("../utils/rawUserFields");
const { convertQueryString } = require("../utils");
const { recordDevice } = require("../utils/deviceContext");
const { auditContext } = require("../utils/auditContext");
const AuditLog = require("../models/AuditLog");

// ─── Auth telemetry ───────────────────────────────────────────────────────────
// Device registry upsert + audit entry for auth events (login/logout/switch).
// Fire-and-forget: never blocks or fails the auth response.
const recordAuthEvent = async ({
  req,
  userId,
  membership,
  action,
  status = "success",
  details = null,
}) => {
  try {
    const purposeByAction = {
      login: "login",
      login_failed: "suspicious_activity",
      logout: "logout",
      switch_context: "api_access",
      register: "registration",
      password_reset_requested: "password_reset",
      password_reset: "password_reset",
      password_reset_failed: "suspicious_activity",
      password_changed: "password_reset",
      password_change_failed: "suspicious_activity",
      profile_updated: "api_access",
      email_confirmed: "device_verification",
      otp_verified: "two_factor_challenge",
      otp_verify_failed: "suspicious_activity",
      otp_sent: "two_factor_challenge",
    };
    const device = userId
      ? await recordDevice({
          req,
          userId,
          purpose: purposeByAction[action] ?? "other",
          client: membership?.clientBelongs ?? null,
          branch: membership?.branchBelongs ?? null,
          details: membership
            ? { userType: membership.userType, role: membership.role }
            : undefined,
        })
      : null;

    await AuditLog.create({
      service: "auth",
      action,
      status,
      details,
      user: userId ?? null,
      client: membership?.clientBelongs ?? null,
      branch: membership?.branchBelongs ?? null,
      ...auditContext(req, device?._id),
    });
  } catch (err) {
    console.error("recordAuthEvent failed:", err.message);
  }
};

// ─── Token response ───────────────────────────────────────────────────────────
// membership = the resolved UserType row (active hat); pass {} when unknown.
const sendTokenResponse = (user, membership, statusCode, res) => {
  const token = user.getSignedJwtToken(membership ?? {});

  const options = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: true,
    path: "/",
    sameSite: "None",
  };

  res.status(statusCode).cookie("token", token, options).json({
    success: true,
    expires: options.expires,
    token,
  });
};

// ─── Email helpers ─────────────────────────────────────────────────────────────
const emailSend = async (user, resetToken, clientUrl, res, next) => {
  const resetUrl = `${clientUrl}confirm-user/${resetToken}`;
  const message = `You are receiving this email because you has requested the reset
  of a password, Please make a PUT request to: \n\n ${resetUrl}`;
  try {
    await sendEmail({
      email: await getRawEmail(user._id),
      subject: "Confirmation Token token",
      message,
    });
    res.status(200).json({ success: true, message: "Email Send Successfully" });
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    return next(new ErrorResponse("Email could not be sent", 500));
  }
};

const optSend = async (user, message, subject, res, next) => {
  try {
    await sendEmail({
      email: await getRawEmail(user._id),
      subject,
      message,
    });
    res.status(200).json({ success: true, message: "Email Send Successfully" });
  } catch (error) {
    return next(new ErrorResponse("Email could not be sent", 500));
  }
};

// ─── Register ─────────────────────────────────────────────────────────────────
// @route  POST /api/v1/auth/register
// @access Public
exports.register = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Customer register'
  #swagger.description = 'Create a new customer user'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/AuthRegisterBody' } }
  #swagger.responses[200] = { description: 'Registered + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'Validation error', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/
  const { name, email, password, role, userName, userType = null } = req.body;
  let clientUrl = req.body.clientUrl || req.header("Referer");

  const existingUser = await User.findOne({ emailHash: hashForSearch(email) });
  if (existingUser) {
    return next(new ErrorResponse("The e-mail address used previous!", 400));
  }

  const newUser = await User.create({ name, email, password, userName });

  // Seed the first UserType membership (idempotent upsert handles re-runs).
  const roleName = role || "user";
  const membership = await UserType.findOneAndUpdate(
    {
      user: newUser._id,
      userType: userType ?? "user",
      role: roleName,
      clientBelongs: null,
      branchBelongs: null,
    },
    { $setOnInsert: { isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const user = await User.findById(newUser._id);

  const code = Math.floor(100000 + Math.random() * 900000);
  const otp = await Otp.create({ code, user: user._id });
  if (!otp) {
    return next(new ErrorResponse("Otp Created Failed", 404));
  }

  const subject = "Verify Your Account – Confirmation Code";
  const message = otpVerificationHtml(code, user.name);
  recordAuthEvent({
    req,
    userId: user._id,
    membership,
    action: "register",
    details: `Registered as ${membership.userType}/${membership.role}`,
  });
  sendTokenResponse(user, membership, 200, res);
  optSend(user, message, subject, res, next);
});

// ─── Login ────────────────────────────────────────────────────────────────────
// @route  POST /api/v1/auth/login
// @access Public
exports.login = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Login user'
  #swagger.description = 'Authenticate user and return a JWT token'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/AuthLoginBody' } }
  #swagger.responses[200] = { description: 'User logged in', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'Invalid credentials', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/

  const requestedType = req.headers["x-user-type"] || req.body.userType || null;

  console.log(requestedType)

  if (!requestedType) {
    return next(new ErrorResponse(`Invalid request or either contact the support team`, 401));
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return next(
      new ErrorResponse("Please provide a valid email and password.", 400)
    );
  }

  // Primary lookup — works for all users once emailHash is set
  let user = await User.findOne({ emailHash: hashForSearch(email) }).select(
    "+password +emailHash"
  );

  // Fallback for existing users who pre-date emailHash (lazy migration).
  if (!user) {
    user = await User.findOne({ email, isDataEncrypted: { $ne: true } }).select(
      "+password +emailHash"
    );
    if (user) {
      await User.updateOne({ _id: user._id }, { emailHash: hashForSearch(email) });
    }
  }

  if (!user) {
    recordAuthEvent({
      req,
      action: "login_failed",
      status: "failed",
      details: "Unknown email",
    });
    return next(new ErrorResponse("Invalid Credential.", 401));
  }

  const isMatch = await user.mathPassword(password);
  if (!isMatch) {
    recordAuthEvent({
      req,
      userId: user._id,
      action: "login_failed",
      status: "failed",
      details: "Wrong password",
    });
    return next(new ErrorResponse("Invalid Credential.", 401));
  }

  // Resolve the membership for the requested userType (from header or body).
  const membership = await resolveMembership(user._id, requestedType);

  // No membership found at all — account exists but has no active hat.
  if (!membership) {
    recordAuthEvent({
      req,
      userId: user._id,
      action: "login_failed",
      status: "failed",
      details: `No active membership for userType "${requestedType}"`,
    });
    return next(new ErrorResponse("Please provide valid credential or either contact the support team", 401));
  }

  // A specific userType was requested but resolveMembership fell back to a
  // different type — that means the requested hat doesn't exist for this user.
  if (requestedType && membership.userType !== requestedType) {
    recordAuthEvent({
      req,
      userId: user._id,
      action: "login_failed",
      status: "failed",
      details: `Requested userType "${requestedType}" not available`,
    });
    return next(new ErrorResponse(`Please provide valid credential or either contact the support team`, 401));
  }

  recordAuthEvent({
    req,
    userId: user._id,
    membership,
    action: "login",
    details: `Logged in as ${membership.userType}/${membership.role}`,
  });

  sendTokenResponse(user, membership, 200, res);
});

// ─── Get Me ───────────────────────────────────────────────────────────────────
// @route  GET /api/v1/auth/me
// @access Private
exports.getMe = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Get current user'
  #swagger.description = 'Returns currently authenticated user + membership list'
  #swagger.responses[200] = { description: 'Current user', schema: { success: true, data: {  } } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
  const clientId = req.user.client?._id ?? null;
  const branchId = req.user.branch?._id ?? null;

  // Build scope conditions. These must match what PUT /privacy/all/bulk
  // actually rewrites (privacyController buildCustomerFilter/buildUserFilter):
  // customers in the tenant, and the portal users linked to those customers.
  // Counting anything else (e.g. branch staff) means the status can never
  // reach "encrypted" and the lock button keeps offering to encrypt.
  const customerScope = [];
  if (clientId) {
    customerScope.push({ "relations.client": clientId });
  }
  if (branchId) {
    customerScope.push({ "relations.branch": branchId });
  }

  const customerFilter = customerScope.length ? { $or: customerScope } : {};
  const customerUserIds = await Customer.distinct("user", {
    ...customerFilter,
    user: { $ne: null },
  });
  const userFilter = { _id: { $in: customerUserIds } };

  let encryptionStatus = false;
  let encryptionData = {};
  try {
    const [totalUsers, encryptedUsers, totalCustomers, encryptedCustomers] =
      await Promise.all([
        User.countDocuments(userFilter),
        User.countDocuments({ ...userFilter, isDataEncrypted: true }),
        Customer.countDocuments(customerFilter),
        Customer.countDocuments({ ...customerFilter, isDataEncrypted: true }),
      ]);

    // A tenant with no linked portal users is still "encrypted" once all its
    // customers are — requiring totalUsers > 0 left the button stuck.
    encryptionStatus =
      totalUsers + totalCustomers > 0 &&
      encryptedUsers === totalUsers &&
      encryptedCustomers === totalCustomers;

    encryptionData = { totalUsers, encryptedUsers, totalCustomers, encryptedCustomers };
  } catch (err) {
    console.error("[getMe] encryptionStatus failed:", err.message);
  }

  // Self-decrypt PII — req.user comes from .lean() so fields may be masked.
  let data = req.user;
  try {
    const userDoc = await User.findById(req.user.id);
    if (userDoc && typeof userDoc.decryptForRole === "function") {
      const decrypted = userDoc.decryptForRole();
      const secretPaths =
        typeof User.getEncryptedPaths === "function" ? User.getEncryptedPaths() : [];
      data = { ...req.user };
      secretPaths.forEach((path) => {
        if (decrypted[path] !== undefined) data[path] = decrypted[path];
      });
    }
  } catch (err) {
    console.error("[getMe] self-decrypt failed:", err.message);
  }

  // Return all active memberships so the UI can show a role switcher.
  let memberships = [];
  try {
    memberships = await UserType.find({ user: req.user.id, isActive: true })
      .populate("roleId", "name description")
      .lean();
  } catch (err) {
    console.error("[getMe] memberships fetch failed:", err.message);
  }

  res.status(200).json({
    success: true,
    encryptionData,
    encryptionStatus,
    data: { ...data, memberships },
  });
});

// ─── Get Me (Customer view) ───────────────────────────────────────────────────
// @route  GET /api/v1/auth/me/customer
// @access Private
exports.getMeCustomer = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Get current user (customer view)'
  #swagger.description = 'Returns user + linked customer record and metadata'
  #swagger.responses[200] = { description: 'User+customer data', schema: { success: true, data: {} } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
  const userId = req.user?.id ?? null;
  if (!userId) return next(new ErrorResponse("Authentication required", 401));

  const user = await User.findById(userId).select("-password").lean();
  if (!user) return next(new ErrorResponse("User not found", 404));

  let customer = await Customer.findOne({ user: user._id })
    .populate("relations.client relations.branch")
    .lean();

  let linkedToCustomer = false;
  let email = user.email ?? null;
  let phone = user.phone ?? null;

  if (customer) {
    linkedToCustomer = true;
    email = customer.metadata?.email;
    phone = customer.metadata?.phone;
  } else {
    const or = [];
    if (email) {
      or.push({ "metadata.email": email });
      or.push({ "personalKyc.personal_form.contact_details.email": email });
    }
    if (phone) {
      or.push({ "metadata.phone": phone });
      or.push({ "personalKyc.personal_form.contact_details.phone": phone });
    }
    if (or.length) {
      customer = await Customer.findOne({ $or: or }).lean();
      if (customer) {
        linkedToCustomer =
          !!customer.user && customer.user.toString() === user._id.toString();
        email =
          customer.metadata?.email ??
          customer.personalKyc?.personal_form?.contact_details?.email ??
          email;
        phone =
          customer.metadata?.phone ??
          customer.personalKyc?.personal_form?.contact_details?.phone ??
          phone;
      }
    }
  }

  const isInviteActive = !!(
    customer?.inviteToken &&
    customer?.inviteTokenExpire &&
    new Date(customer.inviteTokenExpire).getTime() > Date.now()
  );

  const latestCustomer = customer
    ? {
      id: customer._id,
      personalKyc: customer.personalKyc ?? null,
      country: customer.country,
      kycStatus: customer.kycStatus,
      kycNotes: customer.kycNotes,
      metadata: customer.metadata,
      consentToScreen: customer.consentToScreen,
      declaration: customer.declaration,
      authorized: customer.authorized,
      documents: customer.documents,
    }
    : null;

  return res.status(200).json({
    success: true,
    data: {
      customer: latestCustomer,
      email,
      phone,
      userExists: true,
      userId: user._id,
      linkedToCustomer,
      isInviteActive,
      user,
    },
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
// @route  GET /api/v1/auth/logout
// @access Private
exports.logout = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Logout user (clear cookie)'
  #swagger.description = 'Clears cookie token'
  #swagger.responses[200] = { description: 'Logged out', schema: { $ref: '#/definitions/GenericSuccess' } }
*/
  // This route is deliberately unprotected — logout must always succeed, even
  // with an expired session. Best-effort attribution: verify whatever token
  // came with the request (Bearer header or cookie) and record the event;
  // no valid token → clear the cookie silently, nothing to attribute.
  let decoded = null;
  try {
    const token =
      (req.headers.authorization?.startsWith("Bearer") &&
        req.headers.authorization.split(" ")[1]) ||
      req.cookies?.token;
    if (token && token !== "none") {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    }
  } catch {
    decoded = null;
  }

  if (decoded?.id) {
    recordAuthEvent({
      req,
      userId: decoded.id,
      membership: {
        userType: decoded.userType,
        role: decoded.role,
        clientBelongs: decoded.clientBelongs,
        branchBelongs: decoded.branchBelongs,
      },
      action: "logout",
      details: "Logged out",
    });
  }
  res.cookie("token", "none", { expires: new Date(Date.now()), httpOnly: true });
  res.status(200).json({ success: true, data: {} });
});

// ─── Forgot Password ──────────────────────────────────────────────────────────
// @route  POST /api/v1/auth/forgot-password
// @access Public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Request password reset'
  #swagger.description = 'Sends a reset link to the email'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ForgotPasswordBody' } }
  #swagger.responses[200] = { description: 'Reset email sent', schema: { success: true, message: 'Email Send Successfully' } }
  #swagger.responses[404] = { description: 'Email not found', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/
  const { token = null, cid = null, client = null } = req?.body
  const user = await User.findOne({ emailHash: hashForSearch(req.body.email) });
  if (!user) {
    recordAuthEvent({
      req,
      action: "password_reset_requested",
      status: "failed",
      details: "Unknown email",
    });
    return next(new ErrorResponse("The email address is not valid", 404));
  }

  const resetToken = user.getResetPasswordToken();
  await User.updateOne(
    { _id: user._id },
    { resetPasswordToken: user.resetPasswordToken, resetPasswordExpire: user.resetPasswordExpire }
  );

  let resetUrl = '';
  const url = req?.body?.clientUrl ?? req.body.url ?? "";

  if (token && cid) {
    const qry = {
      resetToken,
      token,
      cid,
      client
    }
    resetUrl = `${url}/auth/reset-password?${convertQueryString(qry)}`;

  } else {
    const qry = {
      resetToken,

    }
    resetUrl = `${url}/auth/reset-password?${convertQueryString(qry)}`;

  }
  const message = passwordResetHtml(resetUrl, await getRawName(user._id));

  try {
    await sendEmail({
      email: await getRawEmail(user._id),
      subject: "Reset Your Password – Dooit",
      message,
    });
    recordAuthEvent({
      req,
      userId: user._id,
      action: "password_reset_requested",
      details: "Password reset email sent",
    });
    res.status(200).json({ success: true, message: "Email Send Successfully" });
  } catch (error) {
    await User.updateOne(
      { _id: user._id },
      { resetPasswordToken: undefined, resetPasswordExpire: undefined }
    );
    return next(new ErrorResponse("Email could not be sent", 500));
  }
});


// ─── Reset Password ───────────────────────────────────────────────────────────
// @route  PUT /api/v1/auth/reset-password/:resettoken
// @access Public (token in URL)
exports.resetPassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Reset password'
  #swagger.description = 'Reset user password using reset token'
  #swagger.parameters['resettoken'] = { in: 'path', required: true, type: 'string', description: 'Reset token' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ResetPasswordBody' } }
  #swagger.responses[200] = { description: 'Password reset + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Invalid or expired token', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = []
*/
  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.resettoken)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() },
  });

  if (!user) {
    recordAuthEvent({
      req,
      action: "password_reset_failed",
      status: "failed",
      details: "Invalid or expired reset token",
    });
    return next(new ErrorResponse("Invalid Token.", 401));
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(req.body.password, salt);
  await User.updateOne(
    { _id: user._id },
    { password: hashedPassword, resetPasswordToken: undefined, resetPasswordExpire: undefined }
  );

  const membership = await resolveMembership(user._id, null);
  recordAuthEvent({
    req,
    userId: user._id,
    membership: membership ?? undefined,
    action: "password_reset",
    details: "Password reset via token",
  });
  sendTokenResponse(user, membership ?? {}, 200, res);
});

// ─── Update Me ────────────────────────────────────────────────────────────────
// @route  PUT /api/v1/auth/update-me
// @access Private
exports.updateMe = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Update user profile'
  #swagger.description = 'Update name/email/photo'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdateMeBody' } }
  #swagger.responses[200] = { description: 'Profile updated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
  const updateField = {
    name: req.body.name,
    email: req.body.email,
    photoUrl: req.body.photoUrl,
  };

  const user = await User.findByIdAndUpdate(req.user.id, updateField, {
    new: true,
    runValidators: true,
  });

  // Re-issue the token keeping the user's current active hat.
  const activeMembership = req.user.userTypeId
    ? await UserType.findById(req.user.userTypeId).lean()
    : await resolveMembership(req.user.id, req.user.userType);

  const emailChanged =
    req.body.email !== undefined &&
    String(req.body.email).trim().toLowerCase() !==
      String(req.user.email ?? "").trim().toLowerCase();
  recordAuthEvent({
    req,
    userId: req.user.id,
    membership: activeMembership ?? undefined,
    action: "profile_updated",
    details: emailChanged
      ? "Profile updated — email (recovery channel) changed"
      : "Profile updated",
  });

  sendTokenResponse(user, activeMembership ?? {}, 200, res);
});

// ─── Update Password ──────────────────────────────────────────────────────────
// @route  PUT /api/v1/auth/update-password
// @access Private
exports.updatePassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Update password'
  #swagger.description = 'Change password by providing current and new password'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdatePasswordBody' } }
  #swagger.responses[200] = { description: 'Password updated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Current password mismatch', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
  const user = await User.findById(req.user.id).select("+password");
  if (!(await user.mathPassword(req.body.currentPassword))) {
    recordAuthEvent({
      req,
      userId: req.user.id,
      action: "password_change_failed",
      status: "failed",
      details: "Current password mismatch",
    });
    return next(new ErrorResponse("Current Password not match.", 401));
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(req.body.newPassword, salt);
  await User.updateOne({ _id: user._id }, { password: hashedPassword });

  const freshUser = await User.findById(user._id);
  const activeMembership = req.user.userTypeId
    ? await UserType.findById(req.user.userTypeId).lean()
    : await resolveMembership(req.user.id, req.user.userType);

  recordAuthEvent({
    req,
    userId: user._id,
    membership: activeMembership ?? undefined,
    action: "password_changed",
    details: "Password changed",
  });

  sendTokenResponse(freshUser, activeMembership ?? {}, 200, res);
});

// ─── Customer Register ────────────────────────────────────────────────────────
exports.customerRegister = asyncHandler(async (req, res, next) => {
  const { name, email, password } = req.body;

  const newUser = await User.create({ name, email, password });

  const membership = await UserType.findOneAndUpdate(
    { user: newUser._id, userType: "customer", role: "customer", clientBelongs: null, branchBelongs: null },
    { $setOnInsert: { isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const user = await User.findById(newUser._id);
  sendTokenResponse(user, membership, 200, res);
});

// ─── Confirm User (email token) ───────────────────────────────────────────────
// @route  PUT /api/v1/auth/confirm-user/:resettoken
// @access Public (token in URL)
exports.confirmUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Confirm user (email token)'
  #swagger.description = 'Activate user account using token'
  #swagger.parameters['resettoken'] = { in: 'path', required: true, type: 'string', description: 'Confirmation token' }
  #swagger.responses[200] = { description: 'User activated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Invalid token', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = []
*/
  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.resettoken)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() },
  });

  if (!user) {
    return next(new ErrorResponse("Invalid Token.", 401));
  }

  await User.updateOne(
    { _id: user._id },
    { isActive: true, resetPasswordToken: undefined, resetPasswordExpire: undefined }
  );

  const membership = await resolveMembership(user._id, null);
  recordAuthEvent({
    req,
    userId: user._id,
    membership: membership ?? undefined,
    action: "email_confirmed",
    details: "Account confirmed via email token",
  });
  sendTokenResponse(user, membership ?? {}, 200, res);
});

// ─── Confirm User by OTP ──────────────────────────────────────────────────────
// @route  PUT /api/v1/auth/confirm-user-by-otp
// @access Public
exports.confirmUserByOtp = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Confirm user by OTP'
  #swagger.description = 'Activate user account by OTP code'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ConfirmOtpBody' } }
  #swagger.responses[200] = { description: 'User activated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'OTP expired or invalid', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = []
*/
  const otp = await Otp.find({ expire: { $gt: Date.now() } });

  if (!otp || otp.length === 0) {
    return next(new ErrorResponse("The OTP is Expired!.", 400));
  }

  let userActivated = false;

  for (let index = 0; index < otp.length; index++) {
    const element = otp[index];
    const isMatch = await bcrypt.compare(req.body.code, element.code);

    if (isMatch) {
      const user = await User.findById(element.user);
      if (!user) {
        return next(new ErrorResponse("Invalid Token.", 401));
      }

      await User.updateOne({ _id: user._id }, { isActive: true });

      userActivated = true;
      const membership = await resolveMembership(user._id, null);
      recordAuthEvent({
        req,
        userId: user._id,
        membership: membership ?? undefined,
        action: "otp_verified",
        details: "Account confirmed via OTP",
      });
      sendTokenResponse(user, membership ?? {}, 200, res);
      break;
    }
  }

  if (!userActivated) {
    recordAuthEvent({
      req,
      action: "otp_verify_failed",
      status: "failed",
      details: "Invalid OTP code",
    });
    return next(new ErrorResponse("Invalid Code.", 401));
  }
});

// ─── Resend OTP ───────────────────────────────────────────────────────────────
const createAndSendOtp = async (user, res, next) => {
  await Otp.deleteMany({ user: user._id });

  const code = Math.floor(100000 + Math.random() * 900000);
  const otpExpireMs = 10 * 60 * 1000;
  const otpDoc = await Otp.create({
    code,
    user: user._id,
    expire: Date.now() + otpExpireMs,
  });

  if (!otpDoc) {
    return next(new ErrorResponse("Otp Creation Failed", 500));
  }

  const subject = "Verify Your Account – Confirmation Code";
  const message = otpVerificationHtml(code, user.name);
  return optSend(user, message, subject, res, next);
};

// @route  POST /api/v1/auth/re-send-opt
// @access Public
exports.resendOtp = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Resend OTP'
  #swagger.description = 'Create & send a new OTP to user'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ResendOtpBody' } }
  #swagger.responses[200] = { description: 'OTP sent', schema: { success: true, message: 'Email Send Successfully' } }
  #swagger.responses[429] = { description: 'Too many requests', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = []
*/
  const { email } = req.body;
  if (!email) {
    return next(new ErrorResponse("Please provide an email.", 400));
  }

  const user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user) {
    return next(new ErrorResponse("No user found with that email.", 404));
  }

  if (user.isActive) {
    return next(new ErrorResponse("User already confirmed.", 400));
  }

  const latest = await Otp.findOne({ user: user._id }).sort({ createdAt: -1 });
  const resendThrottleMs = 60 * 1000;
  if (
    latest?.createdAt &&
    Date.now() - latest.createdAt.getTime() < resendThrottleMs
  ) {
    recordAuthEvent({
      req,
      userId: user._id,
      action: "otp_throttled",
      status: "failed",
      details: "OTP resend throttled (60s window)",
    });
    return next(
      new ErrorResponse("Please wait a bit before requesting a new OTP.", 429)
    );
  }

  await createAndSendOtp(user, res, next);
  // headersSent → the OTP was created and the email actually went out.
  if (res.headersSent) {
    recordAuthEvent({
      req,
      userId: user._id,
      action: "otp_sent",
      details: "OTP resent",
    });
  }
});

// ─── Switch Context ───────────────────────────────────────────────────────────
// Re-issues a JWT for a different membership (no user document mutation).
// @route  POST /api/v1/auth/switch-context/:userTypeId
// @access Private
exports.switchContext = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Switch active membership context'
  #swagger.description = 'Re-issue JWT for a different UserType membership (no server-side state change)'
  #swagger.parameters['userTypeId'] = { in: 'path', required: true, type: 'string', description: 'UserType row _id' }
  #swagger.responses[200] = { description: 'New JWT for the selected membership', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[404] = { description: 'Membership not found or inactive' }
*/
  const target = await UserType.findOne({
    _id: req.params.userTypeId,
    user: req.user.id,
    isActive: true,
  }).lean();

  if (!target) {
    return next(new ErrorResponse("Membership not found or inactive", 404));
  }

  const user = await User.findById(req.user.id);
  recordAuthEvent({
    req,
    userId: req.user.id,
    membership: target,
    action: "switch_context",
    details: `Switched context to ${target.userType}/${target.role}`,
  });
  // No user.save() — token-bound context means nothing is mutated server-side.
  sendTokenResponse(user, target, 200, res);
});
