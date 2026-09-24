import type { Server as HttpServer } from 'node:http';
import { Types } from 'mongoose';
import { Server, type Socket } from 'socket.io';
import type { AppDeps } from '../lib/deps.js';
import { ConversationModel, UserModel } from '../models/index.js';
import { resolveSession } from '../services/sessions.js';

interface MessagesSocketData {
  userId: Types.ObjectId;
}

type MessagesSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  MessagesSocketData
>;

/**
 * Socket.IO with a `/messages` namespace. Auth is the same opaque session
 * token the REST API uses, sent as `handshake.auth.token`; there is no JWT.
 * Rooms: `user:<id>` (joined on connect) and `conversation:<id>` (on request,
 * only for conversations the member belongs to).
 */
export function createSocketServer(httpServer: HttpServer, deps: AppDeps): Server {
  const io = new Server(httpServer, {
    cors: { origin: deps.env.CORS_ORIGINS, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  const messages = io.of('/messages');

  messages.use(async (socket: MessagesSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) return next(new Error('unauthenticated'));
    try {
      const session = await resolveSession(token, deps.env.SESSION_TTL_DAYS);
      if (!session) return next(new Error('unauthenticated'));
      const user = await UserModel.exists({ _id: session.userId, deletedAt: null });
      if (!user) return next(new Error('unauthenticated'));
      socket.data.userId = session.userId;
      next();
    } catch (err) {
      deps.logger.error({ err }, 'socket auth failed');
      next(new Error('unauthenticated'));
    }
  });

  messages.on('connection', (socket: MessagesSocket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId.toHexString()}`);
    deps.logger.debug({ socketId: socket.id }, 'messages socket connected');

    const asConversationId = (raw: unknown): Types.ObjectId | null => {
      const value =
        typeof raw === 'object' && raw !== null
          ? (raw as { conversationId?: unknown }).conversationId
          : raw;
      return typeof value === 'string' && Types.ObjectId.isValid(value) && value.length === 24
        ? new Types.ObjectId(value)
        : null;
    };

    socket.on('join:conversation', async (raw: unknown) => {
      const id = asConversationId(raw);
      if (!id) return;
      const member = await ConversationModel.exists({ _id: id, participantIds: userId });
      if (member) socket.join(`conversation:${id.toHexString()}`);
    });

    socket.on('leave:conversation', (raw: unknown) => {
      const id = asConversationId(raw);
      if (id) socket.leave(`conversation:${id.toHexString()}`);
    });

    for (const event of ['typing:start', 'typing:stop'] as const) {
      socket.on(event, (raw: unknown) => {
        const id = asConversationId(raw);
        if (!id) return;
        const room = `conversation:${id.toHexString()}`;
        if (!socket.rooms.has(room)) return;
        socket
          .to(room)
          .emit(event, { conversationId: id.toHexString(), userId: userId.toHexString() });
      });
    }

    socket.on('disconnect', (reason) => {
      deps.logger.debug({ socketId: socket.id, reason }, 'messages socket disconnected');
    });
  });

  return io;
}

/** Fan a new message out to the recipient's personal room and the thread room. */
export function emitNewMessage(
  io: Server,
  recipientIds: Types.ObjectId[],
  conversationId: Types.ObjectId,
  payload: unknown,
): void {
  const ns = io.of('/messages');
  for (const id of recipientIds) ns.to(`user:${id.toHexString()}`).emit('message:new', payload);
  ns.to(`conversation:${conversationId.toHexString()}`).emit('message:new', payload);
}

export function emitMessagesRead(
  io: Server,
  senderId: Types.ObjectId,
  conversationId: Types.ObjectId,
  readBy: Types.ObjectId,
): void {
  io.of('/messages').to(`user:${senderId.toHexString()}`).emit('messages:read', {
    conversationId: conversationId.toHexString(),
    readBy: readBy.toHexString(),
  });
}
