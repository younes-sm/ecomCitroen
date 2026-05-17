"use client";

// Two buttons (camera capture + file upload) shown next to the keyboard input
// when the agent asks for a chassis number / VIN. Either path posts the image
// to /api/rihla/ocr/vin and surfaces a preview the customer must confirm
// before the VIN is sent to the agent. We picked confirm-before-submit on
// purpose — a single mis-OCR'd character (Z vs 2, O vs 0) silently breaks
// the downstream Salesforce booking, so we'd rather pay one extra tap.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, Upload, X, Check, RotateCw, Loader2, Aperture } from "lucide-react";
import type { VoiceLang } from "./LanguagePicker";

type Confidence = "high" | "medium" | "low";

type OcrResponse =
  | { ok: true; vin: string | null; confidence: Confidence; reason?: string }
  | { ok: false; error: string };

type Props = {
  /** Hex accent for buttons. */
  accent: string;
  /** Customer locale — drives button labels. */
  locale: VoiceLang | null;
  /** Called with the customer-confirmed VIN. The caller is responsible for
   *  forwarding it to the agent (typically via the same [FIELD_TYPED] path
   *  the keyboard uses). */
  onConfirm: (vin: string) => void;
  /** Visual theme of the two scan buttons (NOT the camera + confirm modals,
   *  which stay dark-on-black because they overlay the whole viewport). The
   *  voice call view is dark, so the buttons there need light text. The chat
   *  panel is white, so the buttons there need dark text. Defaults to "dark"
   *  to preserve the voice-mode look. */
  theme?: "dark" | "light";
};

type Labels = {
  takePhoto: string;
  upload: string;
  scanning: string;
  scanFailed: string;
  noVin: string;
  confirmTitle: string;
  confirmHint: string;
  useThis: string;
  retake: string;
  cancel: string;
  lowConf: string;
  capture: string;
  cameraDenied: string;
  align: string;
  holdSteady: string;
  capturing: string;
  arming: string;
  noCardRetry: string;
};

const LABELS_FR: Labels = {
  takePhoto: "Photo de la carte grise",
  upload: "Importer",
  scanning: "Lecture du VIN…",
  scanFailed: "Lecture impossible",
  noVin: "Aucun VIN détecté. Réessayez avec une photo plus nette.",
  confirmTitle: "VIN détecté",
  confirmHint: "Vérifiez le numéro avant de l'envoyer.",
  useThis: "Utiliser ce VIN",
  retake: "Reprendre",
  cancel: "Annuler",
  lowConf: "La photo est floue — vérifiez chaque caractère.",
  capture: "Capturer",
  cameraDenied: "Caméra indisponible. Utilisez le bouton « Importer » à la place.",
  align: "Alignez la carte grise dans le cadre",
  holdSteady: "Maintenez stable…",
  capturing: "Capture…",
  arming: "Préparez la carte grise…",
  noCardRetry: "Ce n'est pas une carte grise. Repositionnez et restez stable.",
};

const LABELS_AR: Labels = {
  takePhoto: "صورة carte grise",
  upload: "تحميل",
  scanning: "جاري قراءة الـVIN…",
  scanFailed: "تعذر قراءة الصورة",
  noVin: "لم يتم العثور على VIN. أعد المحاولة بصورة أوضح.",
  confirmTitle: "تم اكتشاف الـVIN",
  confirmHint: "تحقق من الرقم قبل الإرسال.",
  useThis: "استخدم هذا الـVIN",
  retake: "إعادة",
  cancel: "إلغاء",
  lowConf: "الصورة غير واضحة — تحقق من كل حرف.",
  capture: "التقاط",
  cameraDenied: "الكاميرا غير متوفرة. استخدموا زر « تحميل ».",
  align: "ضعوا carte grise داخل الإطار",
  holdSteady: "حافظوا على الثبات…",
  capturing: "جاري الالتقاط…",
  arming: "جهزوا carte grise…",
  noCardRetry: "هذه ليست carte grise. أعيدوا التموضع وثبتوا الكاميرا.",
};

const LABELS_DARIJA: Labels = {
  takePhoto: "صور carte grise",
  upload: "حمّل صورة",
  scanning: "كنقراو الـVIN…",
  scanFailed: "ما قدرناش نقراو الصورة",
  noVin: "ما لقيناش VIN. عاود الصورة بوحدة واضحة.",
  confirmTitle: "VIN تلقّى",
  confirmHint: "تحقق من الرقم.",
  useThis: "استعمل هاد VIN",
  retake: "صور مرة أخرى",
  cancel: "إلغاء",
  lowConf: "الصورة ماشي واضحة — شيك على كل حرف.",
  capture: "صور",
  cameraDenied: "الكاميرا ماشي متاحة. استعمل زر « حمّل صورة ».",
  align: "حط carte grise فالإطار",
  holdSteady: "حافظ على ثبات…",
  capturing: "كنصور…",
  arming: "وجد carte grise…",
  noCardRetry: "ماشي carte grise. عاود ضبط الكاميرا و ثبتها.",
};

const LABELS_EN: Labels = {
  takePhoto: "Photo of the carte grise",
  upload: "Upload",
  scanning: "Reading VIN…",
  scanFailed: "Could not read the image",
  noVin: "No VIN detected. Try again with a sharper photo.",
  confirmTitle: "VIN detected",
  confirmHint: "Check the number before sending.",
  useThis: "Use this VIN",
  retake: "Retake",
  cancel: "Cancel",
  lowConf: "The photo is blurry — verify each character.",
  capture: "Capture",
  cameraDenied: "Camera unavailable. Use the “Upload” button instead.",
  align: "Align the carte grise in the frame",
  holdSteady: "Hold steady…",
  capturing: "Capturing…",
  arming: "Get the carte grise ready…",
  noCardRetry: "Not a carte grise. Reposition and hold still.",
};

function labelsFor(locale: VoiceLang | null): Labels {
  if (locale === "ar") return LABELS_AR;
  if (locale === "darija") return LABELS_DARIJA;
  if (locale === "en") return LABELS_EN;
  return LABELS_FR;
}

export default function VinScanButtons({ accent, locale, onConfirm, theme = "dark" }: Props) {
  const labels = labelsFor(locale);
  // Tailwind utility groups for the two scan buttons. Keep the camera + confirm
  // MODALS dark in both themes — they cover the whole viewport, so the host
  // background colour doesn't matter.
  const btnClass =
    theme === "light"
      ? "flex flex-1 items-center justify-center gap-1.5 rounded-2xl border border-black/10 bg-black/[0.03] px-3 py-2 text-[12px] text-black/80 transition hover:bg-black/[0.06] disabled:opacity-50"
      : "flex flex-1 items-center justify-center gap-1.5 rounded-2xl border border-white/15 bg-white/[0.07] px-3 py-2 text-[12px] text-white/85 transition hover:bg-white/[0.12] disabled:opacity-50";

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [preview, setPreview] = useState<{
    vin: string;
    confidence: Confidence;
    imageDataUrl: string;
  } | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Cleanup media stream on unmount — never leave the camera light on.
  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  const closeCamera = useCallback(() => {
    stopStream();
    setCameraOpen(false);
  }, [stopStream]);

  const openCamera = useCallback(async () => {
    setError(null);
    // getUserMedia is the proper desktop+mobile path. The hidden <input
    // capture="environment"> file input we keep below is a fallback for
    // browsers that block getUserMedia (insecure origin, denied permission).
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      cameraInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      // Wait for the video element to mount via React state, then attach
      // the stream. Capture is manual — user taps the shutter button below.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      console.warn("[vin-scan] getUserMedia failed, falling back to file input:", (err as Error).message);
      // Browser denied / no camera available — fall back to the file picker
      // with capture="environment" (works on iOS Safari + Android Chrome).
      cameraInputRef.current?.click();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runOcr = useCallback(
    async (file: File) => {
      setError(null);
      setScanning(true);
      // Read the file as a data URL once for the preview thumbnail —
      // separately from the OCR request body.
      const reader = new FileReader();
      const previewUrl: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      try {
        const form = new FormData();
        form.append("image", file, file.name || "carte-grise.jpg");
        const res = await fetch("/api/rihla/ocr/vin", {
          method: "POST",
          body: form,
        });
        const data = (await res.json()) as OcrResponse;
        if (!res.ok || !data.ok) {
          const msg = "error" in data ? data.error : `HTTP ${res.status}`;
          setError(msg.slice(0, 120) || labels.scanFailed);
          return;
        }
        if (!data.vin) {
          setError(data.reason ?? labels.noVin);
          return;
        }
        setPreview({
          vin: data.vin,
          confidence: data.confidence,
          imageDataUrl: previewUrl,
        });
      } catch (err) {
        setError((err as Error).message.slice(0, 120) || labels.scanFailed);
      } finally {
        setScanning(false);
      }
    },
    [labels]
  );

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so picking the same file twice still fires onChange.
      e.target.value = "";
      if (file) void runOcr(file);
    },
    [runOcr]
  );

  const confirmVin = useCallback(() => {
    if (!preview) return;
    onConfirm(preview.vin);
    setPreview(null);
  }, [preview, onConfirm]);

  const cancelPreview = useCallback(() => {
    setPreview(null);
    setError(null);
  }, []);

  const retake = useCallback(() => {
    setPreview(null);
    setError(null);
    void openCamera();
  }, [openCamera]);

  // Manual shutter — snap a frame from the live video, send to OCR. The
  // camera modal closes immediately on tap; results land in the OCR preview
  // (success) or the inline error toast (failure).
  const captureFromCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
    if (!blob) return;
    const file = new File([blob], "carte-grise.jpg", { type: "image/jpeg" });
    closeCamera();
    void runOcr(file);
  }, [closeCamera, runOcr]);

  const isRtl = locale === "ar" || locale === "darija";

  return (
    <>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFile}
      />

      <div className="mb-1 flex w-[min(360px,calc(100vw-48px))] items-center gap-2" dir={isRtl ? "rtl" : "ltr"}>
        <button
          type="button"
          onClick={() => void openCamera()}
          disabled={scanning}
          className={btnClass}
          style={{ borderColor: `${accent}55` }}
        >
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} strokeWidth={2} />}
          <span>{labels.takePhoto}</span>
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={scanning}
          className={btnClass}
          style={{ borderColor: `${accent}55` }}
        >
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} strokeWidth={2} />}
          <span>{labels.upload}</span>
        </button>
      </div>

      {error && !preview && (
        <div className="mb-1 w-[min(360px,calc(100vw-48px))] rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
          {error}
        </div>
      )}

      {/* Live camera modal — true webcam access on desktop AND mobile via
          getUserMedia, with the hidden file input as a fallback for browsers
          where getUserMedia is unavailable / denied. */}
      <AnimatePresence>
        {cameraOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col bg-black"
            dir={isRtl ? "rtl" : "ltr"}
          >
            <div className="relative flex-1 overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-cover"
              />
              {/* Card-shaped framing guide so customers know where to align the
                  carte grise — improves OCR hit rate on first try. */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className="rounded-2xl border-2 border-dashed border-white/70"
                  style={{
                    width: "min(85vw, 560px)",
                    aspectRatio: "1.586 / 1",
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                  }}
                />
              </div>
              <button
                type="button"
                onClick={closeCamera}
                aria-label={labels.cancel}
                className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md transition hover:bg-black/75"
              >
                <X size={18} strokeWidth={2} />
              </button>

              {/* Static framing hint — tells the user where to put the card.
                  Auto-capture was reverted at user request; capture is now
                  manual via the shutter button below. */}
              <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-4">
                <div className="max-w-[min(calc(100vw-32px),520px)] rounded-full border border-white/15 bg-black/60 px-3.5 py-1.5 text-center text-[12px] font-medium leading-snug text-white backdrop-blur-md">
                  {labels.align}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-center gap-3 bg-black px-6 py-5 pb-[max(20px,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => void captureFromCamera()}
                disabled={scanning}
                className="flex h-16 w-16 items-center justify-center rounded-full ring-4 ring-white/20 transition active:scale-95 disabled:opacity-50"
                style={{ background: accent }}
                aria-label={labels.capture}
              >
                <Aperture size={26} strokeWidth={2} className="text-white" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-md sm:items-center"
            onClick={cancelPreview}
          >
            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 30, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 0.68, 0, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-[min(420px,calc(100vw-24px))] overflow-hidden rounded-t-3xl border border-white/10 bg-[#15151a] sm:rounded-3xl"
              dir={isRtl ? "rtl" : "ltr"}
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <div>
                  <h3 className="text-[15px] font-medium text-white">{labels.confirmTitle}</h3>
                  <p className="text-[12px] text-white/55">{labels.confirmHint}</p>
                </div>
                <button
                  type="button"
                  onClick={cancelPreview}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.06] hover:text-white"
                  aria-label={labels.cancel}
                >
                  <X size={15} strokeWidth={2} />
                </button>
              </div>

              <div className="px-5 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.imageDataUrl}
                  alt="carte grise"
                  title="carte grise"
                  className="mb-3 max-h-48 w-full rounded-2xl border border-white/10 object-cover"
                />
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                  <div className="font-mono text-[18px] tracking-[0.18em] text-white">{preview.vin}</div>
                  {preview.confidence !== "high" && (
                    <div className="mt-1 text-[11.5px] text-amber-300/85">{labels.lowConf}</div>
                  )}
                </div>
              </div>

              <div className="flex gap-2 border-t border-white/10 bg-white/[0.02] px-5 py-3">
                <button
                  type="button"
                  onClick={retake}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border border-white/10 px-3 py-2 text-[13px] text-white/85 transition hover:bg-white/[0.06]"
                >
                  <RotateCw size={13} strokeWidth={2} />
                  <span>{labels.retake}</span>
                </button>
                <button
                  type="button"
                  onClick={confirmVin}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl px-3 py-2 text-[13px] font-medium text-white transition"
                  style={{ background: accent }}
                >
                  <Check size={14} strokeWidth={2.5} />
                  <span>{labels.useThis}</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
