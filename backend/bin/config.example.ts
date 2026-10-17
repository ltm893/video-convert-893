// backend/bin/config.example.ts
// Copy to config.ts and fill in your values. config.ts is gitignored.
//
//   cp backend/bin/config.example.ts backend/bin/config.ts

export const config = {
  // id is read from the sibling cognito-s3-stack-893/base/bin/config.ts.
  // Set id here only to keep an already-deployed stack name.

  awsRegion: "us-east-1",

  // Cognito User Pool ID — same pool as dropbox-893 (API authorizer; no extra client).
  userPoolId: "us-east-1_XXXXXXXXX",

  // Private bucket from cognito-s3-stack-893 — imported, never created or deleted.
  // Deploy dropbox-893 first. Users open the MP4 from the Dropbox file list.
  // CLI discs land in Videos/. Web uploads land in users/{cognito-sub}/Videos/.
  privateBucket: "your-id-here-private",
};
