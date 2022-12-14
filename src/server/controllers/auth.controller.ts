import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import dayjs from 'dayjs'
import { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { object, string } from 'yup'
import * as types from '../../types'
import { ApiResponse, AuthRequest } from '../../types/shared'
import { ADD_MEMBER, REGISTER_MEMBER, UPDATE_LOGIN_AT, UPDATE_MEMBER } from '../gql/mutations'
import { GET_MEMBER_BY_REFRESH_TOKEN, GET_POSSIBLE_MEMBERS } from '../gql/queries'
import { apolloServerClient } from '../helpers/apollo.server.client'
import MgService from '../helpers/mailgun.client'
import { getMember } from '../helpers/utils'

export const BCRYPT_SALT = 8
const memberRoles = ['site-admin', 'basic-member']

export class AuthController {
  public static registerHandler: RequestHandler = async (req, res: ApiResponse) => {
    // validate input
    const inputSchema = object({
      name: string().required(),
      email: string().email().required(),
      password: string().required(),
    }).required()
    try {
      inputSchema.validateSync(req.body)
    } catch (error) {
      return res.send({ code: 'E_INPUT', message: error.message, result: null })
    }
    const { name, email, password } = inputSchema.cast(req.body)
    // check member existence
    let member
    try {
      member = await AuthController._getMemberByUsernameOrEmail(email)
      if (member) {
        return res.send({ code: 'E_EMAIL_EXISTS', message: 'this email cannot be used', result: null })
      }
    } catch (error) {
      return res.send({ code: 'E_GET_MEMBER', message: error.message, result: null })
    }
    try {
      member = await AuthController._registerMember({
        email,
        name,
        password,
        role: 'basic-member',
      })
      if (!member) {
        return res.send({ code: 'E_NO_MEMBER', message: 'member cannot be registered', result: null })
      }
    } catch (error) {
      return res.send({ code: 'E_REGISTER_MEMBER', message: error.message, result: null })
    }
    try {
      await AuthController._deliverLastLoggedInTask(member.id)
      if (req.session) {
        ;(req.session as any)['afa'] = member.id
      }
    } catch (error) {
      console.error(error)
    }
    return res.send({
      code: 'SUCCESS',
      message: 'successfully register a new member',
      result: {
        authToken: AuthController._signMemberJWT({
          id: member.id,
          name: member.name,
          email: member.email,
          username: member.username,
          avatarUrl: member.avatar_url,
          role: member.role,
        }),
      },
    })
  }
  public static generateUserHandler: RequestHandler = async (req: AuthRequest, res: ApiResponse) => {
    const inputSchema = object({
      name: string(),
      email: string().email(),
      password: string(),
      role: string().required().oneOf(memberRoles),
    }).required()
    try {
      await inputSchema.validate(req.body)
    } catch (error) {
      return res.send({ code: 'E_INPUT', message: error.message, result: null })
    }
    const { name, email, password, role } = inputSchema.cast(req.body)
    if (!req.user) {
      return res.send({ code: 'E_UNAUTHORIZED', message: 'Please login', result: null })
    }
    // User should not add higher role user
    if (memberRoles.indexOf(req.user.role) > memberRoles.indexOf(role)) {
      return res.send({ code: 'E_UNAUTHORIZED', message: 'You cannot add user with higher role', result: null })
    }
    // Role higher than observer should have email & name
    if (memberRoles.indexOf(role) < memberRoles.indexOf('basic-member') && !email && !name) {
      return res.send({ code: 'E_INPUT', message: 'Please fill name & email', result: null })
    }
    const newPassword = password ? password : crypto.randomBytes(20).toString('hex').slice(0, 20)
    let member
    if (role === 'basic-member') {
      const username = Math.random().toString(36).substr(2, 9)
      member = await AuthController._addMember({
        role,
        username,
        password: newPassword,
      })
    } else {
      member = await AuthController._addMember({
        role,
        email,
        name,
        password: newPassword,
      })
    }
    return res.send({ code: 'SUCCESS', message: 'Generate a user successfully', result: member })
  }
  public static changePasswordHandler: RequestHandler = async (req: AuthRequest, res: ApiResponse) => {
    // validate input
    const inputSchema = object({
      password: string().required(),
      newPassword: string().required(),
    }).required()
    try {
      await inputSchema.validate(req.body)
    } catch (error) {
      return res.send({ code: 'E_INPUT', message: error.message, result: null })
    }
    const { password, newPassword } = inputSchema.cast(req.body)
    const member = req.user && (await getMember(req.user.memberId))
    if (!member) {
      return res.send({ code: 'E_NO_MEMBER', message: 'No member', result: null })
    }
    if (member.password_hash) {
      if (!bcrypt.compareSync(password, member.password_hash)) {
        return res.send({ code: 'E_PASSWORD', message: 'incorrect passeword', result: null })
      }
    }
    try {
      await AuthController._setNewPassword(member.id, newPassword)
      return res.send({ code: 'SUCCESS', message: 'password updated successfully', result: null })
    } catch (err) {
      return res.send({ code: 'E_UPDATE_PASSWORD', message: err.message, result: null })
    }
  }
  public static refreshTokenHandler: RequestHandler = async (req, res: ApiResponse) => {
    const memberId = req.session && (req.session as any)['afa']
    if (!memberId) {
      return res.send({ code: 'E_NO_MEMBER', message: 'session expired', result: null })
    }

    const member = await getMember(memberId as any)
    if (!member) {
      return res.send({ code: 'E_NO_MEMBER', message: 'No member found', result: null })
    }

    return res.send({
      code: 'SUCCESS',
      message: 'refresh a new auth token',
      result: {
        authToken: AuthController._signMemberJWT({
          id: member.id,
          name: member.name,
          email: member.email,
          username: member.username,
          avatarUrl: member.avatar_url,
          role: member.role,
        }),
      },
    })
  }
  public static generalLoginHandler: RequestHandler = async (req, res: ApiResponse) => {
    // validate input
    const inputSchema = object({
      account: string().required(),
      password: string().required(),
    }).required()
    try {
      await inputSchema.validate(req.body)
    } catch (err) {
      return res.send({ code: 'E_INPUT', message: err, result: null })
    }
    // get possible members
    const { account, password } = inputSchema.cast(req.body)
    const member = await AuthController._getMemberByUsernameOrEmail(account)
    if (!member) {
      return res.send({ code: 'E_NO_MEMBER', message: 'no such user', result: null })
    }
    // migrated/3rd account with no password
    if (!member.password_hash) {
      try {
        await AuthController._sendResetPasswordEmail({ memberId: member.id })
        return res.send({ code: 'SUCCESS', message: 'sent reset email successfully', result: null })
      } catch (error) {
        return res.send({ code: 'E_SEND_EMAIL', message: error.message, result: null })
      }
    }
    // check password
    if (!bcrypt.compareSync(password, member.password_hash)) {
      return res.send({ code: 'E_PASSWORD', message: 'invalid password', result: null })
    }
    AuthController._deliverLastLoggedInTask(member.id)
    if (req.session) {
      ;(req.session as any)['afa'] = member.id
    }

    return res
      .send({
        code: 'SUCCESS',
        message: 'login successfully',
        result: {
          authToken: AuthController._signMemberJWT({
            id: member.id,
            name: member.name,
            email: member.email,
            username: member.username,
            avatarUrl: member.avatar_url,
            role: member.role,
          }),
        },
      })
      .end()
  }
  public static resetPasswordHandler: RequestHandler = async (req: AuthRequest, res: ApiResponse) => {
    // validate input
    const inputSchema = object({ newPassword: string().required() }).required()
    try {
      await inputSchema.validate(req.body)
    } catch (error) {
      return res.send({ code: 'E_INPUT', message: error.message, result: null })
    }
    const { newPassword } = inputSchema.cast(req.body)
    if (!req.user) {
      return res.send({ code: 'E_NO_MEMBER', message: 'no member', result: null })
    }
    try {
      await AuthController._setNewPassword(req.user.sub, newPassword)
      return res.send({ code: 'SUCCESS', message: 'password updated successfully', result: null })
    } catch (err) {
      return res.send({ code: 'E_UPDATE_PASSWORD', message: err.message, result: null })
    }
  }
  public static forgotPasswordHandler: RequestHandler = async (req, res: ApiResponse) => {
    // validate input
    const inputSchema = object({
      account: string().email().required(),
    }).required()
    try {
      await inputSchema.validate(req.body)
    } catch (error) {
      return res.send({ code: 'E_INPUT', message: error.message, result: null })
    }
    const { account } = inputSchema.cast(req.body)
    const member = await AuthController._getMemberByUsernameOrEmail(account)
    if (!member) {
      return res.send({ code: 'E_NO_MEMBER', message: 'no member found', result: null })
    }
    try {
      await AuthController._sendResetPasswordEmail({ memberId: member.id })
      return res.send({ code: 'SUCCESS', message: 'successfully send reset password email', result: null })
    } catch (error) {
      return res.send({ code: 'E_SEND_EMAIL', message: error.message, result: null })
    }
  }
  public static logoutHandler: RequestHandler = async (req, res: ApiResponse) => {
    if (req.session) {
      req.session.destroy(err => {})
    }
    return res.send({ code: 'SUCCESS', message: 'logout successfully', result: null })
  }
  private static _deliverLastLoggedInTask = async (memberId: string) => {
    await apolloServerClient.mutate<types.UPDATE_LOGIN_AT, types.UPDATE_LOGIN_ATVariables>({
      mutation: UPDATE_LOGIN_AT,
      variables: {
        memberId,
        loginAt: dayjs(),
      },
    })
  }
  private static _getMemberByRefreshToken = async (refreshToken: string) => {
    const { data } = await apolloServerClient.query<
      types.GET_MEMBER_BY_REFRESH_TOKEN,
      types.GET_MEMBER_BY_REFRESH_TOKENVariables
    >({
      query: GET_MEMBER_BY_REFRESH_TOKEN,
      variables: {
        refreshToken,
      },
    })
    const member = data.member.pop() || null
    return member
  }
  private static _getMemberByUsernameOrEmail = async (usernameOrEmail: string) => {
    const { data } = await apolloServerClient.query<types.GET_POSSIBLE_MEMBERS, types.GET_POSSIBLE_MEMBERSVariables>({
      query: GET_POSSIBLE_MEMBERS,
      variables: {
        email: usernameOrEmail,
        username: usernameOrEmail,
      },
    })
    const member = data.member.pop() || null
    return member
  }
  private static _signMemberJWT = (
    member: {
      id: number
      name: string | null
      email: string | null
      username: string | null
      avatarUrl: string | null
      role: string | null
    },
    expiresIn = '1 day',
  ) => {
    return AuthController._signJWT(
      {
        sub: member.id.toString(),
        memberId: member.id,
        name: member.name,
        email: member.email,
        username: member.username,
        avatarUrl: member.avatarUrl,
        role: member.role || 'user',
      },
      expiresIn,
    )
  }
  private static _signJWT = (
    payload: {
      sub: string
      memberId: number
      name: string | null
      email: string | null
      username: string | null
      avatarUrl: string | null
      role: string | null
    },
    expiresIn = '1 day',
  ) => {
    const claim = {
      ...payload,
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': [payload.role],
        'x-hasura-default-role': payload.role,
        'x-hasura-user-id': payload.memberId.toString(),
      },
    }
    if (!process.env.HASURA_JWT_SECRET) {
      throw new Error('no jwt secret')
    }
    return jwt.sign(claim, process.env.HASURA_JWT_SECRET, { expiresIn })
  }
  private static _sendResetPasswordEmail = async ({ memberId }: { memberId: string }) => {
    const mgService = new MgService()
    if (!mgService.isValid) {
      throw new Error('no mail service')
    }
    const member = await getMember(memberId)
    if (!member.email) {
      throw new Error(`no email found for user ${member.id}`)
    }
    const resetPasswordToken = AuthController._signMemberJWT(
      {
        id: member.id,
        name: member.name,
        email: member.email,
        username: member.username,
        avatarUrl: member.avatar_url,
        role: member.role,
      },
      '30 minutes',
    )

    const mgData = {
      from: `${process.env.APP_NAME} <noreply@${process.env.MAILGUN_DOMAIN}>`,
      to: member.email,
      subject: `[${process.env.APP_NAME}] 重設您的密碼`,
      template: 'reset-password',
      'v:appTitle': process.env.APP_NAME,
      'v:appLogoUrl': process.env.APP_LOGO_URL,
      'v:url': `https://${process.env.APP_HOST}/reset-password?token=${resetPasswordToken}`,
    }
    await mgService.send(mgData)
  }
  private static _registerMember = async (profile: {
    role: string
    email: string
    name: string
    password?: string
  }) => {
    const passwordHash = profile.password && (await bcrypt.hash(profile.password, BCRYPT_SALT))
    const { data } = await apolloServerClient.mutate<types.REGISTER_MEMBER, types.REGISTER_MEMBERVariables>({
      mutation: REGISTER_MEMBER,
      variables: {
        name: profile.name,
        email: profile.email,
        role: profile.role,
        passwordHash,
      },
    })
    return data?.insert_member?.returning[0] || null
  }
  private static _addMember = async (profile: {
    role: string
    email?: string
    name?: string
    username?: string
    password: string
  }) => {
    const passwordHash = await bcrypt.hash(profile.password, BCRYPT_SALT)
    const { data } = await apolloServerClient.mutate<types.ADD_MEMBER, types.ADD_MEMBERVariables>({
      mutation: ADD_MEMBER,
      variables: {
        name: profile.name,
        email: profile.email,
        username: profile.username,
        role: profile.role,
        password: profile.role === 'basic-member' ? profile.password : null,
        passwordHash,
      },
    })
    return data?.insert_member?.returning[0] || null
  }
  private static _setNewPassword = async (memberId: string, newPassword: string) => {
    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_SALT)
    await apolloServerClient.mutate({
      mutation: UPDATE_MEMBER,
      variables: {
        memberId,
        updated: {
          password_hash: newPasswordHash,
        },
      },
    })
  }
}
