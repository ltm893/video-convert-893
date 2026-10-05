// backend/bin/config.example.ts
// Copy to config.ts and fill in your values. config.ts is gitignored.
//
//   cp backend/bin/config.example.ts backend/bin/config.ts

export const config = {
  // Short prefix for all AWS resource names.
  // Lowercase letters, numbers, hyphens only.
  id: "your-id-here",

  awsRegion: "us-east-1",

  // Cognito User Pool ID — same pool as dropbox-893 (API authorizer; no extra client).
  userPoolId: "us-east-1_XXXXXXXXX",

  // Existing Dropbox private bucket — imported, never created or deleted.
  // CLI discs land in Videos/. Web uploads land in users/{cognito-sub}/Videos/.
  privateBucket: "your-id-here-private",
};
