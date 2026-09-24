import { Types } from 'mongoose';
import { ActionLogModel } from './actionLog.js';
import { CommentModel } from './comment.js';
import { CompanionConversationModel } from './companionConversation.js';
import { ConversationModel } from './conversation.js';
import { EventModel } from './event.js';
import { EventRsvpModel } from './eventRsvp.js';
import { FriendInviteModel } from './friendInvite.js';
import { FriendshipModel } from './friendship.js';
import { GroveModel } from './grove.js';
import { GroveMemberModel } from './groveMember.js';
import { GuideModel } from './guide.js';
import { MagicLinkModel } from './magicLink.js';
import { MediaItemModel } from './mediaItem.js';
import { MessageModel } from './message.js';
import { NotificationPreferencesModel } from './notificationPreferences.js';
import { OrganizationModel } from './organization.js';
import { PlaceModel } from './place.js';
import { PlaceListModel } from './placeList.js';
import { PlaceReviewModel } from './placeReview.js';
import { PostModel } from './post.js';
import { PushTokenModel } from './pushToken.js';
import { ReactionModel } from './reaction.js';
import { ReportModel } from './report.js';
import { SavedPostModel } from './savedPost.js';
import { ScheduledNotificationModel } from './scheduledNotification.js';
import { SessionModel } from './session.js';
import { UserModel } from './user.js';

export * from './actionLog.js';
export * from './comment.js';
export * from './companionConversation.js';
export * from './conversation.js';
export * from './enums.js';
export * from './event.js';
export * from './eventRsvp.js';
export * from './friendInvite.js';
export * from './friendship.js';
export * from './geo.js';
export * from './grove.js';
export * from './groveMember.js';
export * from './guide.js';
export * from './magicLink.js';
export * from './mediaItem.js';
export * from './message.js';
export * from './notificationPreferences.js';
export * from './organization.js';
export * from './place.js';
export * from './placeList.js';
export * from './placeReview.js';
export * from './post.js';
export * from './pushToken.js';
export * from './reaction.js';
export * from './report.js';
export * from './savedPost.js';
export * from './scheduledNotification.js';
export * from './session.js';
export * from './user.js';
export { Types };

/** Every model, so index creation and test cleanup can iterate the full set. */
export const allModels = [
  ActionLogModel,
  CommentModel,
  CompanionConversationModel,
  ConversationModel,
  EventModel,
  EventRsvpModel,
  FriendInviteModel,
  FriendshipModel,
  GroveModel,
  GroveMemberModel,
  GuideModel,
  MagicLinkModel,
  MediaItemModel,
  MessageModel,
  NotificationPreferencesModel,
  OrganizationModel,
  PlaceModel,
  PlaceListModel,
  PlaceReviewModel,
  PostModel,
  PushTokenModel,
  ReactionModel,
  ReportModel,
  SavedPostModel,
  ScheduledNotificationModel,
  SessionModel,
  UserModel,
] as const;

/**
 * Build every declared index. Idempotent, safe to run on every boot; awaited
 * so unique constraints exist before the first request is served.
 */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(allModels.map((m) => m.createIndexes()));
}
