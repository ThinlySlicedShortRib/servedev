import type { ProviderSpec } from "../declarative";
import aws from "./aws.json";
import azure from "./azure.json";
import cloudflare from "./cloudflare.json";
import digitalocean from "./digitalocean.json";
import docker from "./docker.json";
import firebase from "./firebase.json";
import kubernetes from "./kubernetes.json";
import onepassword from "./onepassword.json";
import stripe from "./stripe.json";
import vercel from "./vercel.json";

/**
 * Ready-made providers offered by "Add platform". Adding one copies its spec into
 * ~/.servedev/providers/<id>.json, where the user can edit it. Bundled into the binary; one JSON
 * file per platform, named after its id. `tested: true` means its list/current commands were run
 * against the real CLI; the others follow the CLI's documentation.
 */
export const CATALOG: ProviderSpec[] = (
  [onepassword, aws, azure, cloudflare, digitalocean, docker, firebase, kubernetes, stripe, vercel] as ProviderSpec[]
).sort((a, b) => a.name.localeCompare(b.name));
