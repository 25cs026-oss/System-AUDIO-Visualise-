/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Mic, Volume2, Settings, Info, Search } from 'lucide-react';
import { GoogleGenAI } from "@google/genai";

export default function App() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensitivity, setSensitivity] = useState(1.5);
  const [smoothing, setSmoothing] = useState(0.8);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackTitleRef = useRef<string>('');

  const [mode, setMode] = useState<'system' | 'microphone'>('system');
  const [showInfo, setShowInfo] = useState(false);
  const [isIdentifying, setIsIdentifying] = useState(false);

  const identifySong = useCallback(async () => {
    if (!streamRef.current || isIdentifying) return;

    setIsIdentifying(true);
    const originalTitle = trackTitleRef.current;
    trackTitleRef.current = "Analyzing Audio Stream...";

    try {
      // 1. Record 5 seconds of audio
      const mediaRecorder = new MediaRecorder(streamRef.current);
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      const recordingPromise = new Promise<Blob>((resolve) => {
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          resolve(blob);
        };
      });

      mediaRecorder.start();
      setTimeout(() => mediaRecorder.stop(), 4000); // Record for 4 seconds (slightly faster)

      const audioBlob = await recordingPromise;

      // 2. Convert to Base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;

      // 3. Call Gemini API
      trackTitleRef.current = "Processing Data...";
      
      // Initialize the client with the API key
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: "Identify this song. Return ONLY the result in the format 'Artist - Title'. If you cannot identify it, return 'Unknown'." },
              {
                inlineData: {
                  mimeType: "audio/webm",
                  data: base64Audio
                }
              }
            ]
          }
        ],
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      const text = response.text;
      
      if (text && !text.includes("Unknown")) {
        trackTitleRef.current = text.trim();
      } else {
         // If unknown, revert to original title (which might be from browser tab)
         // or keep "Unknown" if we want to show that check failed.
         // Let's revert to original if it was valid, or keep "Unknown"
         if (originalTitle && originalTitle !== "Listening..." && originalTitle !== "Analyzing Audio Stream...") {
             trackTitleRef.current = originalTitle;
         } else {
             trackTitleRef.current = "Unknown Signal";
         }
      }

    } catch (error) {
      console.error("Error identifying song:", error);
      trackTitleRef.current = originalTitle || "Signal Lost";
    } finally {
      setIsIdentifying(false);
    }
  }, [isIdentifying]);

  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    trackTitleRef.current = '';
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsCapturing(false);
    
    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, []);

  const startCapture = async () => {
    setError(null);
    try {
      let stream: MediaStream;

      if (mode === 'system') {
        // Request screen sharing with audio
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            }
          });
        } catch (err: any) {
          if (err.name === 'NotAllowedError' && err.message.includes('permission')) {
             throw new Error("Screen capture permission denied. Please allow screen sharing.");
          }
          if (err.message && err.message.includes('display-capture')) {
             throw new Error("Browser blocked screen capture. Try opening this app in a new tab or use Microphone mode.");
          }
          throw err;
        }

        // Check if we got an audio track
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) {
          // Stop the video track immediately if no audio was selected
          stream.getTracks().forEach(t => t.stop());
          throw new Error("No audio track found. Please check 'Share system audio' (Windows) or 'Share tab audio' (Chrome) in the dialog.");
        }
      } else {
        // Microphone mode
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false
        });
      }

      streamRef.current = stream;

      // Set track title from stream label (e.g. tab name)
      if (mode === 'system') {
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && videoTrack.label) {
           // Clean up common suffixes
           let title = videoTrack.label;
           title = title.replace(' - YouTube', '').replace(' - Google Chrome', '').replace(' - Edge', '');
           trackTitleRef.current = title;
        } else {
           trackTitleRef.current = 'System Audio';
        }
      } else {
         trackTitleRef.current = 'Microphone Input';
      }

      // Handle stream end
      const track = mode === 'system' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => stopCapture();
      }

      // Initialize Web Audio API
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = smoothing;
      analyserRef.current = analyser;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      sourceRef.current = source;
      setIsCapturing(true);

      draw();
    } catch (err: any) {
      console.error("Error starting capture:", err);
      setError(err.message || "Failed to start audio capture.");
      stopCapture();
    }
  };

  const draw = () => {
    if (!canvasRef.current || !analyserRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = analyserRef.current;
    analyser.smoothingTimeConstant = smoothing;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    // Get frequency data
    analyser.getByteFrequencyData(dataArray);

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 3;

    // Clear with fade effect for trails
    ctx.fillStyle = 'rgba(21, 22, 25, 0.2)'; // Match card bg
    ctx.fillRect(0, 0, width, height);

    // --- Top Middle: Song Title ---
    if (trackTitleRef.current) {
        ctx.textAlign = 'center';
        
        // "NOW PLAYING" label
        ctx.fillStyle = 'rgba(16, 185, 129, 0.7)'; // Emerald-500
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText('NOW PLAYING', centerX, 30);
        
        // Song Title
        ctx.fillStyle = '#ffffff';
        ctx.font = '500 14px "Inter", sans-serif';
        const title = trackTitleRef.current.length > 40 
            ? trackTitleRef.current.substring(0, 37) + '...' 
            : trackTitleRef.current;
        ctx.fillText(title.toUpperCase(), centerX, 50);
        
        // Underline decoration
        const textWidth = ctx.measureText(title.toUpperCase()).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(centerX - textWidth/2 - 10, 60, textWidth + 20, 1);
    }

    // Calculate bass average (lower frequencies)
    let bassSum = 0;
    const bassBinCount = Math.floor(bufferLength * 0.02); // Use first 2% of bins for deep bass
    for (let i = 0; i < bassBinCount; i++) {
      bassSum += dataArray[i];
    }
    const bassAverage = bassSum / bassBinCount;
    const bassPercent = bassAverage / 255;
    
    // Draw bass circle (pulsing core)
    const bassRadius = (radius - 80) * (0.3 + (bassPercent * 0.4 * sensitivity)); 
    
    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.max(0, bassRadius), 0, 2 * Math.PI);
    // Dynamic color from deep blue to bright cyan based on intensity
    const bassHue = 200 + (bassPercent * 40); 
    ctx.fillStyle = `hsla(${bassHue}, 80%, 50%, ${0.3 + bassPercent * 0.5})`;
    ctx.shadowBlur = 20 + (bassPercent * 40);
    ctx.shadowColor = `hsla(${bassHue}, 80%, 60%, 0.8)`;
    ctx.fill();
    ctx.shadowBlur = 0; // Reset shadow

    // Draw circular visualizer ring
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius - 20, 0, 2 * Math.PI);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.stroke();

    const bars = 120; // Number of bars
    const step = Math.floor(bufferLength / bars);
    
    for (let i = 0; i < bars; i++) {
      const value = dataArray[i * step];
      const percent = value / 255;
      const barHeight = (percent * 100 * sensitivity);
      
      const angle = (i / bars) * 2 * Math.PI;
      
      const x1 = centerX + Math.cos(angle) * radius;
      const y1 = centerY + Math.sin(angle) * radius;
      const x2 = centerX + Math.cos(angle) * (radius + barHeight);
      const y2 = centerY + Math.sin(angle) * (radius + barHeight);
      
      const hue = (i / bars) * 360;
      
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `hsl(${hue}, 70%, 60%)`;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Inner waveform
    const timeData = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(timeData);
    
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    
    const innerRadius = radius - 40;
    
    for (let i = 0; i < bars; i++) {
        const value = timeData[i * step] / 128.0; // 0..2 roughly
        const r = innerRadius * value;
        const angle = (i / bars) * 2 * Math.PI;
        
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.closePath();
    ctx.stroke();

    // --- Song Analyzer (Bottom Right) ---
    const analyzerWidth = 200;
    const analyzerHeight = 60;
    const padding = 20;
    const startX = width - analyzerWidth - padding;
    const startY = height - analyzerHeight - padding;

    // Background for analyzer
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(startX, startY, analyzerWidth, analyzerHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, startY, analyzerWidth, analyzerHeight);

    // Label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText('SPECTRUM ANALYZER', startX + 5, startY - 5);

    // Draw bars
    const analyzerBars = 32;
    const barWidth = (analyzerWidth / analyzerBars) - 1;
    const analyzerStep = Math.floor(bufferLength / analyzerBars);

    for (let i = 0; i < analyzerBars; i++) {
        const value = dataArray[i * analyzerStep];
        const percent = value / 255;
        const h = percent * analyzerHeight;
        
        const x = startX + (i * (barWidth + 1));
        const y = startY + analyzerHeight - h;

        // Gradient color
        const hue = (i / analyzerBars) * 300; // Rainbow spectrum
        ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
        ctx.fillRect(x, y, barWidth, h);
    }

    // --- Peak Meter (Bottom Left) ---
    const meterWidth = 10;
    const meterHeight = 60;
    const meterX = padding;
    const meterY = height - meterHeight - padding;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(meterX, meterY, meterWidth, meterHeight);

    // Calculate RMS (volume)
    let sum = 0;
    for(let i = 0; i < bufferLength; i++) {
        const amplitude = (timeData[i] - 128) / 128;
        sum += amplitude * amplitude;
    }
    const rms = Math.sqrt(sum / bufferLength);
    const volumeHeight = Math.min(rms * 4 * meterHeight, meterHeight); // *4 gain

    // Draw volume bar
    ctx.fillStyle = rms > 0.2 ? '#ef4444' : '#10b981'; // Red if loud, green otherwise
    ctx.fillRect(meterX, meterY + meterHeight - volumeHeight, meterWidth, volumeHeight);
    
    // Label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText('VOL', meterX, meterY - 5);


    animationFrameRef.current = requestAnimationFrame(draw);
  };

  // Auto-identify every 10 seconds
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isCapturing) {
      interval = setInterval(() => {
        if (!isIdentifying) {
          identifySong();
        }
      }, 10000);
    }
    return () => clearInterval(interval);
  }, [isCapturing, isIdentifying, identifySong]);

  // Handle resize - Full Screen
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    
    window.addEventListener('resize', handleResize);
    handleResize();
    
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="fixed inset-0 bg-black overflow-hidden font-mono text-white selection:bg-emerald-500/30">
        
      {/* Background Grid Effect */}
      <div className="absolute inset-0 pointer-events-none opacity-20" 
           style={{
             backgroundImage: 'linear-gradient(rgba(0, 255, 128, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 128, 0.1) 1px, transparent 1px)',
             backgroundSize: '40px 40px'
           }}>
      </div>
      
      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.8)_100%)]"></div>

      {/* Main Canvas */}
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 w-full h-full block"
      />

      {/* HUD Overlay */}
      <div className="absolute inset-0 pointer-events-none p-6 md:p-10 flex flex-col justify-between">
        
        {/* Top Bar */}
        <div className="flex justify-between items-start">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold tracking-[0.2em] text-white/90">AUDIO<span className="text-emerald-500">VIS</span></h1>
                <div className="flex items-center gap-2 text-[10px] text-emerald-500/80 tracking-widest uppercase">
                    <div className={`w-2 h-2 rounded-full ${isCapturing ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                    {isCapturing ? 'System Online' : 'System Offline'}
                </div>
            </div>
            
            <div className="text-right">
                <div className="text-[10px] text-gray-500 tracking-widest mb-1">AUTO-IDENTIFY SEQUENCE</div>
                <div className="flex items-center justify-end gap-2 text-xs text-emerald-500">
                    <span className={isIdentifying ? "animate-pulse" : ""}>{isIdentifying ? 'SCANNING...' : 'ACTIVE (10s)'}</span>
                    <div className="w-16 h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 animate-[shimmer_2s_infinite]"></div>
                    </div>
                </div>
            </div>
        </div>

        {/* Center Message (if idle) */}
        {!isCapturing && !error && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="w-24 h-24 mx-auto mb-6 rounded-full border border-white/10 flex items-center justify-center animate-[spin_10s_linear_infinite]">
                    <div className="w-20 h-20 rounded-full border border-dashed border-white/20"></div>
                </div>
                <h2 className="text-xl tracking-[0.5em] text-white/50 mb-2">INITIALIZE SYSTEM</h2>
                <p className="text-xs text-emerald-500/50 tracking-widest">WAITING FOR INPUT STREAM</p>
              </div>
            </div>
        )}

        {/* Error Message */}
        {error && (
             <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 p-8 backdrop-blur-sm">
               <div className="text-center max-w-md border border-red-500/30 bg-red-900/10 p-8 rounded-lg">
                 <div className="text-red-500 mb-2 font-mono text-lg tracking-widest">CRITICAL ERROR</div>
                 <p className="text-gray-400 text-sm mb-6">{error}</p>
                 <button 
                   onClick={() => setError(null)}
                   className="px-6 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/50 text-red-500 text-xs uppercase tracking-widest transition-colors pointer-events-auto"
                 >
                   Acknowledge
                 </button>
               </div>
             </div>
        )}

        {/* Bottom Bar */}
        <div className="flex justify-between items-end">
             {/* Left: Tech Specs */}
             <div className="hidden md:block text-[10px] text-gray-600 space-y-1 font-mono">
                 <div>FFT_SIZE: 2048</div>
                 <div>SMOOTHING: {smoothing.toFixed(2)}</div>
                 <div>SENSITIVITY: {sensitivity.toFixed(1)}</div>
                 <div>RENDER: 60FPS</div>
             </div>

             {/* Right: Controls Toggle (if needed) */}
             <div className="pointer-events-auto">
                 {/* Controls are floating, defined below */}
             </div>
        </div>
      </div>

      {/* Floating Controls Panel */}
      <div className="absolute bottom-8 right-8 z-10 flex flex-col gap-4 pointer-events-auto">
          
          {/* Main Toggle */}
          {!isCapturing ? (
            <button
              onClick={startCapture}
              className="group relative w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/50 hover:bg-emerald-500/20 hover:scale-110 transition-all flex items-center justify-center backdrop-blur-md"
            >
               <Play className="w-6 h-6 text-emerald-500 fill-emerald-500" />
               <div className="absolute inset-0 rounded-full border border-emerald-500/30 animate-ping opacity-20"></div>
            </button>
          ) : (
            <button
              onClick={stopCapture}
              className="group relative w-16 h-16 rounded-full bg-red-500/10 border border-red-500/50 hover:bg-red-500/20 hover:scale-110 transition-all flex items-center justify-center backdrop-blur-md"
            >
               <Square className="w-6 h-6 text-red-500 fill-red-500" />
            </button>
          )}

          {/* Settings / Info Group */}
          <div className="flex flex-col gap-2 bg-black/50 backdrop-blur-md p-2 rounded-full border border-white/10">
             <button 
               onClick={() => setShowInfo(true)}
               className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
             >
                <Info className="w-5 h-5" />
             </button>
             
             {/* Mode Toggle (Compact) */}
             <button 
               onClick={() => setMode(mode === 'system' ? 'microphone' : 'system')}
               disabled={isCapturing}
               className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${isCapturing ? 'opacity-50' : 'hover:bg-white/10 hover:text-white'} ${mode === 'microphone' ? 'text-emerald-500' : 'text-gray-400'}`}
               title={mode === 'system' ? "Switch to Mic" : "Switch to System"}
             >
                <Mic className="w-5 h-5" />
             </button>

             {/* Manual Identify */}
             <button 
               onClick={identifySong}
               disabled={!isCapturing || isIdentifying}
               className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${isIdentifying ? 'animate-pulse text-emerald-500' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
             >
                <Search className="w-5 h-5" />
             </button>
          </div>
      </div>

      {/* Info Modal (Reused) */}
      {showInfo && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-lg">
          <div className="bg-black border border-emerald-500/30 w-full max-w-2xl max-h-[90vh] overflow-y-auto relative">
            {/* Decorative corners */}
            <div className="absolute top-0 left-0 w-4 h-4 border-t border-l border-emerald-500"></div>
            <div className="absolute top-0 right-0 w-4 h-4 border-t border-r border-emerald-500"></div>
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b border-l border-emerald-500"></div>
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b border-r border-emerald-500"></div>

            <div className="p-6 border-b border-white/5 flex items-center justify-between sticky top-0 bg-black/95 z-10">
              <h2 className="text-emerald-500 font-mono text-xl tracking-[0.2em]">SYSTEM_INFO</h2>
              <button 
                onClick={() => setShowInfo(false)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <Square className="w-5 h-5 fill-current" />
              </button>
            </div>
            
            <div className="p-8 space-y-8 font-mono">
              <section>
                <h3 className="text-white/50 text-xs uppercase tracking-widest mb-3 border-b border-white/10 pb-2">Operational Logic</h3>
                <p className="text-gray-400 text-sm leading-relaxed">
                  Real-time audio frequency analysis via <strong className="text-emerald-500">Web Audio API</strong>. 
                  Automatic signal identification sequence active every 15 seconds.
                </p>
              </section>

              <section>
                <h3 className="text-white/50 text-xs uppercase tracking-widest mb-3 border-b border-white/10 pb-2">Input Modules</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-white/5 p-4 border border-white/5 hover:border-emerald-500/50 transition-colors">
                    <div className="text-emerald-500 text-xs mb-1 tracking-wider">MODULE_01</div>
                    <div className="text-white text-sm">System Audio Capture</div>
                    <div className="text-gray-600 text-[10px] mt-1">getDisplayMedia API</div>
                  </div>
                  <div className="bg-white/5 p-4 border border-white/5 hover:border-emerald-500/50 transition-colors">
                    <div className="text-emerald-500 text-xs mb-1 tracking-wider">MODULE_02</div>
                    <div className="text-white text-sm">Microphone Array</div>
                    <div className="text-gray-600 text-[10px] mt-1">getUserMedia API</div>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-red-500/70 text-xs uppercase tracking-widest mb-3 border-b border-red-900/30 pb-2">System Constraints</h3>
                <ul className="space-y-2 text-gray-500 text-xs">
                  <li className="flex gap-3 items-start">
                    <span className="text-red-500">•</span>
                    <span>System audio capture restricted by browser security policies (Desktop Recommended).</span>
                  </li>
                  <li className="flex gap-3 items-start">
                    <span className="text-red-500">•</span>
                    <span>Amplitude visualization dependent on source volume levels.</span>
                  </li>
                </ul>
              </section>
            </div>

            <div className="p-6 border-t border-white/5 bg-white/5">
              <button 
                onClick={() => setShowInfo(false)}
                className="w-full py-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 font-mono text-xs uppercase tracking-[0.2em] transition-colors border border-emerald-500/20 hover:border-emerald-500/50"
              >
                Terminate Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
