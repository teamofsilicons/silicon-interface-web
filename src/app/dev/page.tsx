"use client";

import * as React from "react";

import { api } from "@/lib/api";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { EndpointCard } from "@/components/dev/endpoint-card";
import { WsLog } from "@/components/dev/ws-log";

export default function DevPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">/dev</h1>
        <p className="text-sm text-muted-foreground">
          Raw endpoint explorer. Every request is signed with whatever token is in your auth
          store. Switch between groups below.
        </p>
      </header>

      <Tabs defaultValue="profile">
        <TabsList className="flex flex-wrap gap-1">
          <TabsTrigger value="profile">profile</TabsTrigger>
          <TabsTrigger value="health">health</TabsTrigger>
          <TabsTrigger value="rooms">rooms</TabsTrigger>
          <TabsTrigger value="events">events</TabsTrigger>
          <TabsTrigger value="search">search</TabsTrigger>
          <TabsTrigger value="voice">voice</TabsTrigger>
          <TabsTrigger value="media">media</TabsTrigger>
          <TabsTrigger value="orgs">orgs</TabsTrigger>
          <TabsTrigger value="silicons">silicons</TabsTrigger>
          <TabsTrigger value="cost">cost</TabsTrigger>
          <TabsTrigger value="ws">ws log</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>

        <TabsContent value="health">
          <HealthTab />
        </TabsContent>

        <TabsContent value="rooms">
          <RoomsTab />
        </TabsContent>

        <TabsContent value="events">
          <EventsTab />
        </TabsContent>

        <TabsContent value="search">
          <SearchTab />
        </TabsContent>

        <TabsContent value="voice">
          <VoiceTab />
        </TabsContent>

        <TabsContent value="media">
          <MediaTab />
        </TabsContent>

        <TabsContent value="orgs">
          <OrgsTab />
        </TabsContent>

        <TabsContent value="silicons">
          <SiliconsTab />
        </TabsContent>

        <TabsContent value="cost">
          <CostTab />
        </TabsContent>

        <TabsContent value="ws">
          <WsLog />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---- Tabs ----
function ProfileTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="GET /carbons/me"
        method="GET"
        path="/api/v1/carbons/me"
        controls={null}
        run={() => api.me()}
      />
      <EndpointCard
        title="GET /silicons/me"
        method="GET"
        path="/api/v1/silicons/me"
        description="Only succeeds when signed in with X-Silicon-Key."
        controls={null}
        run={() => api.meSilicon()}
      />
      <HandleLookupCard />
      <TakeBackPolicyCard />
    </div>
  );
}

function HealthTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="healthz"
        method="GET"
        path="/healthz"
        controls={null}
        run={() => api.healthz()}
      />
      <EndpointCard
        title="readyz"
        method="GET"
        path="/readyz"
        controls={null}
        run={() => api.readyz()}
      />
      <EndpointCard
        title="version"
        method="GET"
        path="/api/v1/version"
        controls={null}
        run={() => api.version()}
      />
      <DevOtpPeekCard />
    </div>
  );
}

function HandleLookupCard() {
  const [kind, setKind] = React.useState<"carbon" | "silicon">("carbon");
  const [handle, setHandle] = React.useState("");
  return (
    <EndpointCard
      title="handle lookup"
      method="GET"
      path={`/api/v1/handle/${kind}/{handle}`}
      controls={
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label>kind</Label>
            <select
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as "carbon" | "silicon")}
            >
              <option value="carbon">carbon</option>
              <option value="silicon">silicon</option>
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label>handle</Label>
            <Input value={handle} onChange={(e) => setHandle(e.target.value)} />
          </div>
        </div>
      }
      run={() => (kind === "carbon" ? api.carbonByHandle(handle) : api.siliconByHandle(handle))}
    />
  );
}

function TakeBackPolicyCard() {
  const [threshold, setThreshold] = React.useState(2);
  const [duration, setDuration] = React.useState(9000);
  const [enabled, setEnabled] = React.useState(true);
  return (
    <EndpointCard
      title="take-back policy"
      method="GET / PATCH"
      path="/api/v1/carbons/me/take-back-policy"
      controls={
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label>threshold</Label>
            <Input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label>duration secs</Label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label>enabled</Label>
            <select
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={String(enabled)}
              onChange={(e) => setEnabled(e.target.value === "true")}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>
      }
      run={() =>
        api.setTakeBackPolicy({
          unread_threshold_msgs: threshold,
          unread_duration_secs: duration,
          enabled,
        })
      }
    />
  );
}

function DevOtpPeekCard() {
  const [target, setTarget] = React.useState("");
  return (
    <EndpointCard
      title="dev: peek last OTP"
      method="GET"
      path="/api/v1/dev/last-otp"
      description="DEBUG-only. Brute-forces the 6-digit code from the stored sha256 hash."
      controls={
        <div className="space-y-1">
          <Label>target (email or +phone)</Label>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="alice@example.com OR +14155551212"
          />
        </div>
      }
      run={() => api.devLastOtp(target)}
    />
  );
}

function RoomsTab() {
  const [name, setName] = React.useState("test-room");
  const [topic, setTopic] = React.useState("");
  const [targetKind, setTargetKind] = React.useState<"carbon" | "silicon">("carbon");
  const [targetId, setTargetId] = React.useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="list rooms"
        method="GET"
        path="/api/v1/rooms/"
        controls={null}
        run={() => api.rooms()}
      />
      <EndpointCard
        title="create group room"
        method="POST"
        path="/api/v1/rooms/"
        controls={
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>topic</Label>
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
          </div>
        }
        run={() => api.createRoom(name, topic)}
      />
      <EndpointCard
        title="direct room"
        method="POST"
        path="/api/v1/rooms/direct"
        controls={
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label>target kind</Label>
              <select
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                value={targetKind}
                onChange={(e) => setTargetKind(e.target.value as "carbon" | "silicon")}
              >
                <option value="carbon">carbon</option>
                <option value="silicon">silicon</option>
              </select>
            </div>
            <div className="col-span-2 space-y-1">
              <Label>target id (ULID)</Label>
              <Input value={targetId} onChange={(e) => setTargetId(e.target.value)} />
            </div>
          </div>
        }
        run={() => api.directRoom(targetKind, targetId)}
      />
    </div>
  );
}

function EventsTab() {
  const [roomId, setRoomId] = React.useState("");
  const [body, setBody] = React.useState("hello world");
  const [progressState, setProgressState] = React.useState("thinking");
  const [progressGroup, setProgressGroup] = React.useState("g1");
  const [progressNote, setProgressNote] = React.useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="list events"
        method="GET"
        path="/api/v1/rooms/{room_id}/events"
        controls={
          <div className="space-y-1">
            <Label>room_id</Label>
            <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          </div>
        }
        run={() => api.events(roomId)}
      />
      <EndpointCard
        title="send m.text"
        method="POST"
        path="/api/v1/rooms/{room_id}/events"
        controls={
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>room_id</Label>
              <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>body</Label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
            </div>
          </div>
        }
        run={() =>
          api.sendEvent(roomId, { type: "m.text", content: { body } })
        }
      />
      <EndpointCard
        title="post m.progress"
        method="POST"
        path="/api/v1/rooms/{room_id}/progress"
        description="Silicon-only. `done` persists, others fan out over WS only."
        controls={
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-3 space-y-1">
              <Label>room_id</Label>
              <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>state</Label>
              <select
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                value={progressState}
                onChange={(e) => setProgressState(e.target.value)}
              >
                {["reading_file", "writing_file", "executing", "searching_web", "thinking", "done"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>group</Label>
              <Input value={progressGroup} onChange={(e) => setProgressGroup(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>note</Label>
              <Input value={progressNote} onChange={(e) => setProgressNote(e.target.value)} />
            </div>
          </div>
        }
        run={() =>
          api.postProgress(roomId, {
            state: progressState,
            progress_group_id: progressGroup,
            note: progressNote,
          })
        }
      />
    </div>
  );
}

function SearchTab() {
  const [q, setQ] = React.useState("");
  const [room, setRoom] = React.useState("");
  return (
    <EndpointCard
      title="search events"
      method="GET"
      path="/api/v1/events/search"
      controls={
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label>q</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>room (optional)</Label>
            <Input value={room} onChange={(e) => setRoom(e.target.value)} />
          </div>
        </div>
      }
      run={() => api.search({ q, room: room || undefined })}
    />
  );
}

function VoiceTab() {
  const [roomId, setRoomId] = React.useState("");
  const [text, setText] = React.useState("hello from silicon");
  const [voice, setVoice] = React.useState("Puck");
  const [scene, setScene] = React.useState("");
  const [style, setStyle] = React.useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-1">
      <EndpointCard
        title="POST /tts"
        method="POST"
        path="/api/v1/tts"
        description="Queues a TTS job. Result lands as an m.tts event in room_id."
        controls={
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 space-y-1">
              <Label>text</Label>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1">
              <Label>voice</Label>
              <Input value={voice} onChange={(e) => setVoice(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>room_id</Label>
              <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>scene</Label>
              <Input value={scene} onChange={(e) => setScene(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>style</Label>
              <Input value={style} onChange={(e) => setStyle(e.target.value)} />
            </div>
          </div>
        }
        run={() => api.tts({ text, voice, scene, style, room_id: roomId })}
      />
    </div>
  );
}

function MediaTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">media uploads</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Easiest way to test the media pipeline is to send a file from the chat composer.
          For raw flow: <code className="text-xs">POST /api/v1/media/upload-url</code> →
          PUT the file → poll <code className="text-xs">GET /api/v1/media/{`{media_id}`}</code>.
          In dev mode the presigned URL is fake and you can manually call the scan webhook
          with <code className="text-xs">curl</code> + <code className="text-xs">X-Scan-Token</code>.
        </p>
      </CardContent>
    </Card>
  );
}

function OrgsTab() {
  const [name, setName] = React.useState("Acme");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="list orgs"
        method="GET"
        path="/api/v1/orgs/"
        controls={null}
        run={() => api.orgs()}
      />
      <EndpointCard
        title="create org"
        method="POST"
        path="/api/v1/orgs/"
        description="The creator becomes admin."
        controls={
          <div className="space-y-1">
            <Label>name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        }
        run={() => api.createOrg({ name })}
      />
    </div>
  );
}

function SiliconsTab() {
  const [siliconId, setSiliconId] = React.useState("");
  const [label, setLabel] = React.useState("dev");
  const [name, setName] = React.useState("Ada");
  const [orgSlug, setOrgSlug] = React.useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="create silicon"
        method="POST"
        path="/api/v1/silicons/"
        description="You must be an org admin."
        controls={
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>org_slug</Label>
              <Input value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} />
            </div>
          </div>
        }
        run={() => api.createSilicon({ name, org_slug: orgSlug })}
      />
      <EndpointCard
        title="mint silicon API key"
        method="POST"
        path="/api/v1/silicons/{silicon_id}/api-keys"
        description="Plaintext is shown ONCE. Store it now."
        controls={
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>silicon_id</Label>
              <Input value={siliconId} onChange={(e) => setSiliconId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          </div>
        }
        run={() => api.mintSiliconKey(siliconId, label)}
      />
    </div>
  );
}

function CostTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EndpointCard
        title="cost summary"
        method="GET"
        path="/api/v1/cost/summary"
        description="Staff (is_staff) only."
        controls={null}
        run={() => api.costSummary()}
      />
      <EndpointCard
        title="recent attempts"
        method="GET"
        path="/api/v1/cost/recent"
        controls={null}
        run={() => api.costRecent()}
      />
    </div>
  );
}
