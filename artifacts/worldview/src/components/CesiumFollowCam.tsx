import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

const ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0YjdkMmFmMS04ZmU2LTQ4NDYtYTIwMS1hOTg5NGM2NzEzNGYiLCJpZCI6Mzk3MjQyLCJpYXQiOjE3NzI1Mzk5NDV9.sQ4V9RmCN2-xnXW2WZDxSAgaZTZFn9pohwFD9YzmWoU";

Cesium.Ion.defaultAccessToken = ION_TOKEN;

export interface FollowAircraft {
  hex: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  track?: number;
  gs?: number;
}

interface Props {
  aircraft: FollowAircraft;
  modelUrl: string;
}

const FT_TO_M = 0.3048;
const KTS_TO_MS = 0.514444;
const EARTH_R = 6378137;

function altMetersFromBaro(alt: FollowAircraft["alt_baro"]): number {
  if (alt === undefined || alt === null) return 300;
  if (alt === "ground") return 0;
  const n = Number(alt);
  if (isNaN(n)) return 300;
  return n * FT_TO_M;
}

// Tileset-only custom shader: tints Google 3D buildings/terrain into a
// dark blue/cyan night-vision look without affecting the aircraft model.
const TILESET_NIGHT_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.UNLIT,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 c = material.diffuse;
      float gray = dot(c, vec3(0.299, 0.587, 0.114));
      gray = pow(gray, 1.6) * 0.55;
      material.diffuse = vec3(gray * 0.18, gray * 0.78, gray * 1.0);
      material.alpha = 1.0;
    }
  `,
});

export function CesiumFollowCam({ aircraft, modelUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const aircraftRef = useRef<FollowAircraft>(aircraft);
  // Smoothed display position (lon, lat, altMeters) — lerped toward the
  // latest ADS-B sample each frame to avoid snap-jumps.
  const displayRef = useRef<{ lon: number; lat: number; alt: number; track: number } | null>(null);

  useEffect(() => {
    aircraftRef.current = aircraft;
    // Seed display position on first valid sample so we don't render at (0,0).
    if (
      displayRef.current === null &&
      aircraft.lat !== undefined &&
      aircraft.lon !== undefined
    ) {
      displayRef.current = {
        lon: aircraft.lon,
        lat: aircraft.lat,
        alt: altMetersFromBaro(aircraft.alt_baro),
        track: aircraft.track ?? 0,
      };
    }
  }, [aircraft.lat, aircraft.lon, aircraft.alt_baro, aircraft.track, aircraft.gs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let viewer: Cesium.Viewer | null = null;

    (async () => {
      try {
        viewer = new Cesium.Viewer(container, {
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          baseLayer: false,
          // Keep skyBox / skyAtmosphere / sun / moon ENABLED — Cesium ships
          // a real star map and astronomically-correct sun & moon. We just
          // freeze the clock below so they sit in the same spot every load.
        });

        if (cancelled) {
          viewer.destroy();
          return;
        }

        const scene = viewer.scene;
        scene.globe.show = false;
        // Pure deep-space black so the star map reads cleanly.
        scene.backgroundColor = Cesium.Color.BLACK;

        // ---- Lock the simulation clock so sun/moon/stars are stable ----
        // Picked so that for most populated regions you get a believable
        // night sky with stars and a distant moon visible.
        const fixedTime = Cesium.JulianDate.fromIso8601(
          "2024-06-15T22:30:00Z",
        );
        viewer.clock.startTime = fixedTime.clone();
        viewer.clock.currentTime = fixedTime.clone();
        viewer.clock.stopTime = fixedTime.clone();
        viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
        viewer.clock.shouldAnimate = false;
        viewer.clock.multiplier = 0;

        // Real star map (skyBox), real sun, real moon — all on.
        if (scene.sun) scene.sun.show = true;
        if (scene.moon) scene.moon.show = true;
        // Atmosphere OFF: with no globe to anchor it, scattering renders as
        // a tan/brown wall around the camera and hides the stars.
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;

        // Fog OFF — at cruise altitude over hidden-globe space it just
        // adds a grey wash. The Google tileset already has its own haze.
        scene.fog.enabled = false;

        // Directional headlight illuminating the aircraft from the camera angle so
        // the aircraft model and textures are clearly visible day or night.
        const updateLight = () => {
          if (!viewer || viewer.isDestroyed()) return;
          const cam = viewer.scene.camera;
          scene.light = new Cesium.DirectionalLight({
            direction: Cesium.Cartesian3.clone(cam.directionWC),
            color: Cesium.Color.WHITE,
            intensity: 2.5,
          });
        };
        updateLight();

        // Photorealistic 3D tiles with night-vision shader
        try {
          const tileset = await Cesium.createGooglePhotorealistic3DTileset();
          if (cancelled) return;
          tileset.customShader = TILESET_NIGHT_SHADER;
          scene.primitives.add(tileset);
        } catch (e) {
          console.error("Failed to load Google 3D tileset", e);
        }

        // ---- Smooth position: exponential lerp toward latest ADS-B sample ----
        // Updated ONCE per frame in scene.preRender. The CallbackProperty
        // readers below just read the cached display state — that prevents
        // dt from being consumed by multiple callers in the same frame.
        const SMOOTH_TAU = 0.45; // seconds — tight enough to feel "live"
        let lastFrameMs = performance.now();
        scene.preRender.addEventListener(() => {
          updateLight();
          const a = aircraftRef.current;
          const now = performance.now();
          const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
          lastFrameMs = now;
          if (
            a.lat === undefined ||
            a.lon === undefined ||
            displayRef.current === null
          ) {
            return;
          }
          const target = {
            lon: a.lon,
            lat: a.lat,
            alt: altMetersFromBaro(a.alt_baro),
            track: a.track ?? displayRef.current.track,
          };
          const k = 1 - Math.exp(-dt / SMOOTH_TAU);
          const d = displayRef.current;
          d.lon += (target.lon - d.lon) * k;
          d.lat += (target.lat - d.lat) * k;
          d.alt += (target.alt - d.alt) * k;
          const dh = ((target.track - d.track + 540) % 360) - 180;
          d.track += dh * k;
        });

        const computePosition = (): Cesium.Cartesian3 => {
          const d = displayRef.current;
          if (!d) return Cesium.Cartesian3.fromDegrees(0, 0, 0);
          return Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt);
        };

        const positionProperty = new Cesium.CallbackProperty(
          () => computePosition(),
          false,
        );

        const orientationProperty = new Cesium.CallbackProperty(() => {
          const pos = computePosition();
          const headingDeg = displayRef.current?.track ?? 0;
          const hpr = new Cesium.HeadingPitchRoll(
            Cesium.Math.toRadians(headingDeg - 90),
            0,
            0,
          );
          return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
        }, false);

        // ---- Aircraft model ----
        const aircraftEntity = viewer.entities.add({
          position: positionProperty as unknown as Cesium.PositionProperty,
          orientation: orientationProperty as unknown as Cesium.Property,
          model: {
            uri: modelUrl,
            minimumPixelSize: 96,
            maximumScale: 500,
            scale: 2.2,
            shadows: Cesium.ShadowMode.DISABLED,
            imageBasedLightingFactor: new Cesium.Cartesian2(1.0, 1.0),
            color: Cesium.Color.WHITE,
          },
        });

        // ---- Body-frame lights ----
        // Body offsets in metres: (forward, right, up). Forward is along the
        // aircraft's track, right is starboard, up is local-up.
        const lights: {
          offset: [number, number, number];
          color: Cesium.Color;
          size: number;
          strobe?: boolean;
          glow?: number;
        }[] = [
          { offset: [0, -28, 0], color: Cesium.Color.RED, size: 14, glow: 0.6 },           // left wingtip nav
          { offset: [0, 28, 0], color: Cesium.Color.LIME, size: 14, glow: 0.6 },           // right wingtip nav
          { offset: [-22, 0, 4], color: Cesium.Color.WHITE, size: 14, strobe: true, glow: 0.7 }, // tail strobe
          { offset: [12, 0, 1], color: Cesium.Color.fromCssColorString("#ffd99a"), size: 8, glow: 0.4 }, // forward cabin
          { offset: [4, 0, 1], color: Cesium.Color.fromCssColorString("#ffd99a"), size: 8, glow: 0.4 },
          { offset: [-4, 0, 1], color: Cesium.Color.fromCssColorString("#ffd99a"), size: 8, glow: 0.4 },
          { offset: [-12, 0, 1], color: Cesium.Color.fromCssColorString("#ffd99a"), size: 8, glow: 0.4 },
          { offset: [0, 0, -3], color: Cesium.Color.RED, size: 12, strobe: true, glow: 0.7 }, // belly anti-collision
        ];

        const computeLightPosition = (
          fwd: number,
          rt: number,
          up: number,
        ): Cesium.Cartesian3 => {
          const planePos = computePosition();
          const trackRad = Cesium.Math.toRadians(displayRef.current?.track ?? 0);
          const sinT = Math.sin(trackRad);
          const cosT = Math.cos(trackRad);
          // body (fwd, rt, up) → local ENU (east, north, up)
          const east = fwd * sinT + rt * cosT;
          const north = fwd * cosT - rt * sinT;
          const enuOffset = new Cesium.Cartesian3(east, north, up);
          const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(planePos);
          return Cesium.Matrix4.multiplyByPoint(
            enuMatrix,
            enuOffset,
            new Cesium.Cartesian3(),
          );
        };

        for (const l of lights) {
          const [fwd, rt, up] = l.offset;
          const colorProp = new Cesium.CallbackProperty(() => {
            if (!l.strobe) return l.color;
            // ~1.2 Hz strobe, on for 80ms
            const t = performance.now() % 850;
            return t < 110
              ? l.color.withAlpha(1.0)
              : l.color.withAlpha(0.05);
          }, false);
          viewer.entities.add({
            position: new Cesium.CallbackProperty(
              () => computeLightPosition(fwd, rt, up),
              false,
            ) as unknown as Cesium.PositionProperty,
            point: {
              pixelSize: l.size,
              color: colorProp as unknown as Cesium.Property,
              outlineColor: Cesium.Color.TRANSPARENT,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scaleByDistance: new Cesium.NearFarScalar(50, 1.4, 5000, 0.4),
            },
          });
        }

        // ---- Sparse high-altitude clouds (billboards in plane's local frame) ----
        // Generated once with a deterministic seed so they don't shuffle on
        // every load. They follow the plane (always nearby) but parallax as
        // the camera orbits.
        const cloudCanvas = document.createElement("canvas");
        cloudCanvas.width = 256;
        cloudCanvas.height = 128;
        const cctx = cloudCanvas.getContext("2d");
        if (cctx) {
          const grad = cctx.createRadialGradient(128, 64, 10, 128, 64, 110);
          grad.addColorStop(0, "rgba(220,235,255,0.55)");
          grad.addColorStop(0.5, "rgba(180,210,235,0.18)");
          grad.addColorStop(1, "rgba(180,210,235,0)");
          cctx.fillStyle = grad;
          cctx.fillRect(0, 0, 256, 128);
        }
        const cloudImg = cloudCanvas.toDataURL();

        let cloudSeed = 1337;
        const rand = () => {
          // tiny LCG for deterministic placement
          cloudSeed = (cloudSeed * 1664525 + 1013904223) >>> 0;
          return cloudSeed / 0xffffffff;
        };
        const cloudOffsets: Array<[number, number, number, number]> = []; // east, north, up, scale
        for (let i = 0; i < 14; i++) {
          const east = (rand() - 0.5) * 18000; // ±9 km
          const north = (rand() - 0.5) * 18000;
          const up = (rand() - 0.5) * 600 - 100; // mostly slightly below the plane
          const scale = 0.9 + rand() * 1.6;
          cloudOffsets.push([east, north, up, scale]);
        }

        for (const [east, north, up, scale] of cloudOffsets) {
          viewer.entities.add({
            position: new Cesium.CallbackProperty(() => {
              const d = displayRef.current;
              if (!d) return Cesium.Cartesian3.fromDegrees(0, 0, 0);
              const planePos = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt);
              const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(planePos);
              return Cesium.Matrix4.multiplyByPoint(
                enuMatrix,
                new Cesium.Cartesian3(east, north, up),
                new Cesium.Cartesian3(),
              );
            }, false) as unknown as Cesium.PositionProperty,
            billboard: {
              image: cloudImg,
              width: 1400 * scale,
              height: 700 * scale,
              sizeInMeters: true,
              color: Cesium.Color.fromCssColorString("#cfe2f5").withAlpha(0.55),
              translucencyByDistance: new Cesium.NearFarScalar(
                500, 0.25, 8000, 0.7,
              ),
            },
          });
        }

        // ---- Camera: free orbit around the aircraft ----
        // Set chase offset BEFORE assigning trackedEntity. Cesium's
        // EntityView reads defaultOffset3D when first attached. Using
        // viewer.zoomTo here would cancel tracking entirely.
        // Offset is in the entity's local east-north-up frame: (E, N, U).
        // 160 m behind (-N), 100 m above (+U) → tight top-down chase view.
        Cesium.EntityView.defaultOffset3D = new Cesium.Cartesian3(0, -160, 100);

        // Wait until we have a real ADS-B sample seeded, then start tracking.
        const startTracking = () => {
          if (!viewer || viewer.isDestroyed()) return;
          if (!displayRef.current) return false;
          viewer.trackedEntity = aircraftEntity;
          return true;
        };
        if (!startTracking()) {
          const tryAttach = () => {
            if (startTracking()) {
              scene.preRender.removeEventListener(tryAttach);
            }
          };
          scene.preRender.addEventListener(tryAttach);
        }

        // Allow zooming far in/out (so user can see space above & details)
        const ctrl = scene.screenSpaceCameraController;
        ctrl.minimumZoomDistance = 30;
        ctrl.maximumZoomDistance = 8_000_000;
        ctrl.enableCollisionDetection = false; // let camera pass under terrain

        viewerRef.current = viewer;
      } catch (e) {
        console.error("Cesium viewer init failed", e);
      }
    })();

    return () => {
      cancelled = true;
      const v = viewerRef.current;
      viewerRef.current = null;
      try {
        if (v && !v.isDestroyed()) v.destroy();
        else if (viewer && !viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "#000005",
      }}
    />
  );
}
