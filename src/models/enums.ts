/**
 * Enumerations shared by the Mongoose schemas and the zod request schemas so
 * a value is valid at the boundary exactly when it is valid in the database.
 */

export const HOME_AREAS = [
  'la_westside',
  'la_eastside',
  'south_bay',
  'long_beach',
  'sgv',
  'sfv',
  'orange_county',
  'inland_empire',
  'san_diego',
  'ventura',
  'other',
] as const;
export type HomeArea = (typeof HOME_AREAS)[number];

export const USER_ROLES = ['member', 'admin'] as const;
export const AUTH_PROVIDERS = ['apple', 'google'] as const;
export const CLIENTS = ['ios', 'android', 'web'] as const;
export type Client = (typeof CLIENTS)[number];

export const FRIENDSHIP_STATUSES = ['pending', 'accepted'] as const;

export const PLACE_TYPES = [
  'sanctuary',
  'restaurant',
  'cafe',
  'grocery',
  'shop',
  'organization',
  'venue',
  'garden',
] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];
export const VEGAN_LEVELS = ['full', 'options'] as const;
export type VeganLevel = (typeof VEGAN_LEVELS)[number];
export const APPROVAL_STATUSES = ['private', 'pending', 'approved', 'rejected'] as const;
/**
 * Sources the API itself writes. Ingested rows carry a free-form source id
 * (`ics:farmsanctuary`, `wikidata`, `bot:grokbot`); see the ingest contract.
 */
export const BUILT_IN_SOURCES = ['osm', 'user', 'curated'] as const;
export const REVIEW_STATUSES = ['active', 'removed'] as const;

export const INGEST_RESOURCES = ['places', 'events', 'organizations', 'media', 'guides'] as const;
export type IngestResource = (typeof INGEST_RESOURCES)[number];

export const ORGANIZATION_TYPES = ['org', 'sanctuary', 'business'] as const;
export const GROVE_ROLES = ['member', 'organizer'] as const;

export const EVENT_TYPES = [
  'protest',
  'vigil',
  'outreach',
  'potluck',
  'sanctuary_day',
  'screening',
  'meeting',
  'other',
] as const;
export const HOST_TYPES = ['grove', 'organization'] as const;
export const EVENT_VISIBILITIES = ['public', 'grove', 'friends'] as const;
/** `pending` is the moderation queue for ingested events; members' own drafts stay `draft`. */
export const EVENT_STATUSES = ['draft', 'pending', 'published', 'cancelled'] as const;
export const RSVP_STATUSES = ['going', 'interested'] as const;

export const MEDIA_TYPES = ['image', 'video', 'carousel'] as const;
export const POST_VISIBILITIES = ['friends', 'grove', 'public'] as const;
export const POST_STATUSES = ['processing', 'published', 'removed'] as const;
export const COMMENT_STATUSES = ['active', 'removed'] as const;
export const REACTION_TYPES = ['love'] as const;

export const REPORT_TARGETS = ['post', 'comment', 'place', 'review', 'user', 'message'] as const;
export const REPORT_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'] as const;

export const MESSAGE_TYPES = ['text', 'shared'] as const;

export const MEDIA_KINDS = ['documentary', 'film', 'series', 'talk', 'short'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
/** "This moved me" and "I took action": the two low-friction reactions on a title. */
export const MEDIA_REACTION_TYPES = ['moved', 'acted'] as const;
export type MediaReactionType = (typeof MEDIA_REACTION_TYPES)[number];
export const WATCH_ACCESS = ['free', 'subscription', 'rent', 'buy', 'unknown'] as const;
export type WatchAccess = (typeof WATCH_ACCESS)[number];
export const MEDIA_ACTION_TYPES = [
  'petition',
  'donate',
  'pledge',
  'volunteer',
  'guide',
  'learn',
] as const;
/** The topic vocabulary that drives the automatic home rows. Free tags are allowed beside these. */
export const MEDIA_TOPIC_TAGS = [
  'ethics',
  'health',
  'environment',
  'activism',
  'investigation',
] as const;
export const PUBLISH_STATUSES = ['draft', 'published'] as const;
export const GUIDE_CATEGORIES = [
  'outreach',
  'rights',
  'vegan101',
  'sanctuary',
  'nutrition',
  'other',
] as const;

export const ACTION_TYPES = ['event_attended', 'outreach', 'volunteer', 'other'] as const;
export const COMPANION_ROLES = ['user', 'assistant'] as const;
export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'cancelled', 'failed'] as const;
export const NOTIFICATION_KINDS = ['event_reminder', 'friend_request', 'message'] as const;

export const UPLOAD_PURPOSES = ['avatar', 'post', 'place', 'event'] as const;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
