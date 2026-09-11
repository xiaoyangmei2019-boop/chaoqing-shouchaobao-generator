// Network adapter. Each task calls one generation/edit endpoint; no automatic POST retry.
function findImagePayload(value,depth=0){if(!value||depth>8)return null;if(typeof value==="object"){if(value.b64_json||value.b64||value.partial_image_b64||value.image_url||value.url)return value;for(let child of Object.values(value)){let found=findImagePayload(child,depth+1);if(found)return found}}return null}
function decodeImageBase64(value) {
  if (typeof value !== 'string') throw new Error('接口返回的图片 Base64 不是文本格式');
  let raw = value.trim(), mime = 'image/png';
  if (/^data:/i.test(raw)) {
    const comma = raw.indexOf(','), header = comma >= 0 ? raw.slice(0, comma) : raw;
    if (comma < 0 || !/;base64(?:;|$)/i.test(header)) throw new Error('接口返回的图片 Data URL 格式不正确');
    const match = header.match(/^data:([^;,]+)/i);
    if (match) mime = match[1].toLowerCase();
    raw = raw.slice(comma + 1);
  }
  // Gateways sometimes wrap long Base64 lines, use URL-safe characters, or
  // omit the trailing padding. All are valid transport variations.
  raw = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) throw new Error('接口返回的图片 Base64 为空');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('接口返回的图片 Base64 含有非法字符');
  raw = raw.replace(/=+$/, '');
  const remainder = raw.length % 4;
  if (remainder === 1) throw new Error('接口返回的图片 Base64 数据不完整');
  if (remainder) raw += '='.repeat(4 - remainder);
  let binary;
  try { binary = atob(raw); }
  catch { throw new Error('接口返回的图片 Base64 无法解码，数据可能被截断'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!bytes.length) throw new Error('接口返回的图片文件为空');
  return { bytes, mime };
}
async function imageBlob(data){let d=findImagePayload(data)||data?.data?.[0]||data?.result?.data?.[0]||data?.output?.[0]||data,encoded=d?.b64_json||d?.b64||d?.partial_image_b64;if(encoded){if(typeof encoded==='string'&&/^https?:\/\//i.test(encoded.trim()))d={...d,url:encoded.trim()};else{let decoded=decodeImageBase64(encoded);return new Blob([decoded.bytes],{type:decoded.mime})}}let url=d?.url||d?.image_url||data?.image_url||data?.url;if(url){let lastError;for(let attempt=0;attempt<2;attempt++){try{let r=await fetch(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.blob()}catch(e){lastError=e;if(!attempt)await new Promise(resolve=>setTimeout(resolve,800))}}let origin="未知图片域名";try{origin=new URL(url).origin}catch{}throw new Error(`图片已在后台生成，但浏览器无法下载返回图片（${origin}）：${lastError?.message||"连接失败"}。可能是图片域名跨域限制或临时链接失效`)}throw new Error("接口已响应，但没有找到图片数据")}
async function fetchApi(url,options={}){return new Promise((resolve,reject)=>{let xhr=new XMLHttpRequest();xhr.open(options.method||"GET",url,true);xhr.timeout=0;xhr.responseType="blob";for(let[key,value]of Object.entries(options.headers||{}))xhr.setRequestHeader(key,value);xhr.onload=()=>{let headers=new Headers();for(let line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)){let i=line.indexOf(":");if(i>0)headers.append(line.slice(0,i).trim(),line.slice(i+1).trim())}resolve(new Response(xhr.response,{status:xhr.status,statusText:xhr.statusText,headers}))};xhr.onerror=()=>reject(new Error("生图连接被远端中断（XHR 状态 0）。客户端已设置为永不超时，请核对中转的跨域长连接配置和扣费记录，不要立即重复提交"));xhr.ontimeout=()=>reject(new Error("生图请求发生超时；当前客户端 timeout=0，正常情况下不会主动超时"));xhr.onabort=()=>reject(new Error("生图请求已被中止"));xhr.send(options.body??null)})}
async function submitAsyncImageTask(base,path,bodyFactory,headers,apiKey,clientRequestId){let lastError=null;for(let attempt=0;attempt<2;attempt++){try{let response=await fetch(base+"/"+path,{method:"POST",headers:{...headers,Authorization:"Bearer "+apiKey,"Idempotency-Key":clientRequestId},body:bodyFactory(),cache:"no-store"}),text=await response.text(),data=null;try{data=JSON.parse(text)}catch{}if(!response.ok)throw Object.assign(new Error(data?.error||`异步后台提交失败（HTTP ${response.status}）`),{confirmed:true});if(!data?.id)throw new Error("异步后台没有返回任务ID");return data}catch(error){lastError=error;if(error?.confirmed)throw error;if(!attempt)await new Promise(resolve=>setTimeout(resolve,700))}}let error=new Error(`无法连接自己的异步后台：${lastError?.message||"网络连接失败"}。本次任务使用幂等编号保护，重新恢复时不会重复提交收费请求`);error.uncertain=true;throw error}
async function pollAsyncImageTask(base,id){let interval=1800,networkFailures=0;while(true){await new Promise(resolve=>setTimeout(resolve,interval));let data;try{let response=await fetch(base+"/"+encodeURIComponent(id),{cache:"no-store"}),text=await response.text();try{data=JSON.parse(text)}catch{}if(!response.ok)throw new Error(data?.error||`查询任务失败（HTTP ${response.status}）`);networkFailures=0}catch(error){networkFailures++;interval=Math.min(8000,1800+networkFailures*500);continue}interval=1800;if(["queued","running"].includes(data.status))continue;if(data.status==="failed"){let suffix=data.upstreamRequestId?`（上游 Request ID：${data.upstreamRequestId}）`:"",error=new Error((data.error||"后台任务失败")+suffix);error.confirmed=true;throw error}if(data.status!=="succeeded")continue;while(true){try{let response=await fetch(new URL(data.resultUrl,base).href,{cache:"no-store"});if(!response.ok)throw new Error(`HTTP ${response.status}`);let blob=await response.blob();if(!blob.size)throw new Error("图片文件为空");return{blob,points:Number(data.points||0),serverTaskId:id}}catch{await new Promise(resolve=>setTimeout(resolve,2500))}}}}
async function parseApiResponse(res){let type=(res.headers.get("content-type")||"").toLowerCase();if(type.startsWith("image/"))return{directBlob:await res.blob()};if(type.includes("text/event-stream")&&res.body?.getReader){let reader=res.body.getReader(),decoder=new TextDecoder(),buffer="",latest=null,fallback=null,streamError=null,consume=line=>{let text=line.trim();if(!text.startsWith("data:"))return;text=text.replace(/^data:\s*/,"");if(!text||text==="[DONE]")return;try{let parsed=JSON.parse(text);fallback=parsed;let found=findImagePayload(parsed);if(found)latest=found;let message=parsed?.error?.message||((parsed?.type||"").includes("error")?parsed?.message:"");if(message)streamError=new Error(message)}catch{}};try{while(true){let{value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";lines.forEach(consume);if(done)break}if(buffer.trim())consume(buffer)}catch(e){if(latest)return latest;throw new Error(`图片流接收中断：${e?.message||"网络连接失败"}`)}if(latest)return latest;if(streamError)throw streamError;if(fallback)return fallback;throw new Error(`接口流式响应结束，但没有收到图片数据（HTTP ${res.status}）`)}let raw=await res.text(),text=raw.trim();if(!text)throw new Error(`接口返回空内容（HTTP ${res.status}）`);try{return JSON.parse(text)}catch{}let events=text.split(/\r?\n/).filter(x=>x.trim().startsWith("data:")).map(x=>x.replace(/^\s*data:\s*/,"")).filter(x=>x&&x!=="[DONE]"),fallback=null;for(let i=events.length-1;i>=0;i--){try{let parsed=JSON.parse(events[i]);fallback||=parsed;if(findImagePayload(parsed))return parsed}catch{}}if(fallback)return fallback;if(/^https?:\/\//i.test(text))return{url:text};if(/^data:image\//i.test(text)){let comma=text.indexOf(",");return{b64:text.slice(comma+1)}}throw new Error(`接口返回格式暂不兼容（HTTP ${res.status}，类型 ${type||"未知"}）`)}
const LINE_ART_PROMPT="请根据原图生成简化的动漫风格黑白线稿，不是完整照搬，而是进行干净清晰的线稿化重绘。保留原图的整体构图、主体位置、人物动态、主要物体外形和基本识别特征，保持原图比例。只保留大轮廓、关键结构和必要内部线条，主动省略花纹、纹理、装饰线和不必要小细节，整体简洁清爽，留白充足，适合儿童涂色、SVG转换或绘图仪输出。人物只保留外轮廓、五官、发型、主要发饰、大块服装结构和少量褶皱线。场景和物体只保留主要外轮廓、基本结构和少量内部线条。如有文字：保留的文字改为镂空描边线稿字；删除的文字只删除字形本身，注意只删除小字，不能删除大标题，不删除文字底框、标题牌、文本框、分隔线、卷轴结构和原有版式，框内留白。线条要求纯黑色线条、纯白色背景、无灰度、无阴影、无颜色、无渐变、无杂线、无脏边。全图不得出现任何实心黑色填充，所有封闭区域内部保持白色。";
function lineArtRequestSize(sourceDimensions) {
  const aspect = sourceDimensions.width / sourceDimensions.height;
  let longSide=3360,width,height,minPixels=655360,maxPixels=8294400;
  if(aspect>=1){width=longSide;height=Math.max(16,Math.round(longSide/aspect/16)*16)}else{height=longSide;width=Math.max(16,Math.round(longSide*aspect/16)*16)}
  let pixels=width*height;if(pixels>maxPixels){let scale=Math.sqrt(maxPixels/pixels);width=Math.max(16,Math.floor(width*scale/16)*16);height=Math.max(16,Math.floor(height*scale/16)*16)}
  pixels=width*height;if(pixels<minPixels){let scale=Math.sqrt(minPixels/pixels);width=Math.ceil(width*scale/16)*16;height=Math.ceil(height*scale/16)*16}
  while(width*height>maxPixels){if(width>=height)width-=16;else height-=16}
  return{width,height,size:`${width}x${height}`}
}
