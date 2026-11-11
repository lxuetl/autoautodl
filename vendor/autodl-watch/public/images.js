'use strict';
const imageSelects=['#image-framework','#image-version','#image-python','#image-cuda'].map(id=>$(id));
const imageNames=['框架','框架版本','Python（系统）','CUDA'];
let imageRevision=0,imageLoading=false,imageMode=null,imageCheckedAt=null,imageMessage='',imageWasReady=false;
function imagePrefix(level){return imageSelects.slice(0,level).map(select=>select.value);}
function imageSelectionReady(){return imageSelects.every(select=>!!select.value)&&!!$('#task-form').elements.imagePath.value;}
function invalidateImagePath(){
  const form=$('#task-form');form.elements.imagePath.value='';
  if(currentMode==='create')form.elements.cuda.value='';
  window.clearPricing?.();
}
function resetImageLevels(from){
  for(let i=from;i<4;i++){
    const option=new Option(i===0?'请先同步官方镜像':'请先选择'+imageNames[i-1],'');option.disabled=true;
    imageSelects[i].replaceChildren(option);imageSelects[i].value='';imageSelects[i].disabled=true;
  }
  invalidateImagePath();
}
function renderImages(){
  // 后台会等当前一轮监测结束再读菜单，所以监测任务运行时也可以同步镜像。
  const ready=accountReady(),busy=!!browserAction||!!accountBusy;
  const button=$('#sync-images');button.disabled=imageLoading||busy||!ready||currentMode!=='create';
  button.textContent=imageLoading?'正在同步…':'同步官方镜像';
  for(let i=0;i<4;i++){
    const select=imageSelects[i];select.required=currentMode==='create';
    select.disabled=currentMode!=='create'||imageLoading||!ready||!select.options.length||!Array.from(select.options).some(option=>!!option.value&&!option.disabled);
  }
  const node=$('#image-status');node.classList.toggle('error',imageMessage.startsWith('同步失败'));
  node.textContent=!ready?'请先登录 AutoDL 并检查登录状态，再同步官方基础镜像。':imageMessage||(imageSelectionReady()?'已选择完整官方镜像。':'登录后点击同步，依次选择框架、框架版本、Python 和 CUDA。');
}
function updateImageForm(){
  const form=$('#task-form'),create=currentMode==='create';
  if(imageMode!==currentMode){
    imageRevision++;
    if(imageLoading)imageMessage='上次同步因切换模式已取消，请重新同步，或重新选择上级环境。';
    imageLoading=false;
    // 克隆不填写 CUDA：环境随源实例系统盘，首次检查时从 AutoDL 克隆页读取。
    form.elements.cuda.value=create&&imageSelectionReady()?imageSelects[3].value.replace(/^CUDA\s*/i,''):'';
    imageMode=currentMode;
  }
  // CUDA 不单独显示：新建由第四级镜像带入隐藏字段，克隆随源实例。
  form.elements.cuda.required=create;
  $('#cuda-hint').textContent=create?'新建时 CUDA 随下方选择的官方镜像带入，宿主驱动需支持它；扩容数据盘可能在关机后继续计费。':'克隆原样复制源实例的系统盘，Python、PyTorch、CUDA 与源实例相同，不需要填写。首次检查时从 AutoDL 克隆页读取源环境 CUDA，只选驱动支持它的主机；读到的版本写在任务日志中。';
  form.elements.imagePath.required=create;form.elements.imagePath.disabled=!create;
  renderImages();
}
async function loadImageLevel(level){
  const revision=++imageRevision,prefix=imagePrefix(level);imageLoading=true;
  imageMessage='正在读取 AutoDL 官方'+imageNames[level]+'选项…';renderImages();
  try{
    const result=await api('/api/autodl/images',{prefix});
    if(revision!==imageRevision||currentMode!=='create')return;
    if(result.level!==level||JSON.stringify(result.prefix)!==JSON.stringify(prefix)||!Array.isArray(result.options))throw Error('官方菜单响应与当前路径不一致，请重新同步');
    const labels=new Set(),options=[];
    for(const item of result.options){
      if(typeof item.label!=='string'||!item.label.trim()||labels.has(item.label))throw Error('官方镜像菜单含无效或重名选项，请核对页面');
      labels.add(item.label);const option=new Option(item.label,item.label);option.disabled=!!item.disabled;options.push(option);
    }
    const placeholder=new Option('请选择'+imageNames[level],'');placeholder.disabled=true;
    imageSelects[level].replaceChildren(placeholder,...options);imageSelects[level].value='';
    imageCheckedAt=result.checkedAt;
    imageMessage=options.some(option=>!option.disabled)?'已读取官方'+imageNames[level]+'选项，请选择后继续。最近同步 '+time(imageCheckedAt,true):'当前分支暂无可用的'+imageNames[level]+'选项，请选择其他上级环境或重新同步。';
  }catch(error){
    if(revision!==imageRevision)return;
    resetImageLevels(level);imageMessage='同步失败：'+error.message;toast(imageMessage,true);
  }finally{if(revision===imageRevision){imageLoading=false;renderImages();}}
}
$('#sync-images').addEventListener('click',()=>{imageRevision++;resetImageLevels(0);void loadImageLevel(0);});
imageSelects.forEach((select,level)=>select.addEventListener('change',()=>{
  imageRevision++;resetImageLevels(level+1);
  if(!select.value)return;
  if(level<3){void loadImageLevel(level+1);return;}
  const cuda=select.value.match(/^(?:CUDA\s*)?(1\d\.\d{1,2})$/i)?.[1];
  if(!cuda){imageMessage='当前镜像 CUDA 无法识别，请选择其他官方选项。';renderImages();return;}
  const form=$('#task-form');form.elements.imagePath.value=imagePrefix(4).join(' / ');form.elements.cuda.value=cuda;
  imageMessage='已选择官方镜像，CUDA 已自动带入。最近同步 '+time(imageCheckedAt,true)+'；提交前会再次核对。';
  window.clearPricing?.();window.renderBudget?.();renderImages();
}));
window.addEventListener('appstatechange',()=>{
  const ready=accountReady();
  if(!ready&&imageWasReady){imageRevision++;imageLoading=false;resetImageLevels(0);imageMessage='';}
  imageWasReady=ready;renderImages();
});
// 环境规划逐级读取了官方菜单并选好选项：按返回的每级选项填入下拉框；中途停下的级别留给用户自己选。
window.applyImagePlan=result=>{
  if(currentMode!=='create'||!Array.isArray(result?.levels))return false;
  imageRevision++;imageLoading=false;resetImageLevels(0);
  for(const {level,options,label} of result.levels){
    if(!Number.isInteger(level)||level<0||level>3||!Array.isArray(options))break;
    const placeholder=new Option('请选择'+imageNames[level],'');placeholder.disabled=true;
    imageSelects[level].replaceChildren(placeholder,...options.filter(o=>typeof o?.label==='string').map(o=>{const option=new Option(o.label,o.label);option.disabled=!!o.disabled;return option;}));
    imageSelects[level].value=label||'';
    if(!label)break;
  }
  imageCheckedAt=result.checkedAt||Date.now();
  if(result.complete&&imageSelectionValues().every(Boolean)){
    const cuda=imageSelects[3].value.match(/^(?:CUDA\s*)?(1\d\.\d{1,2})$/i)?.[1],form=$('#task-form');
    if(cuda){form.elements.imagePath.value=imagePrefix(4).join(' / ');form.elements.cuda.value=cuda;}
    imageMessage='已按规划选择官方镜像，CUDA 已自动带入；可以改选。提交前会再次核对。';
  }else imageMessage='规划在这一级停下，请自行选择后续选项。';
  window.clearPricing?.();window.renderBudget?.();renderImages();
  return !!$('#task-form').elements.imagePath.value;
};
function imageSelectionValues(){return imageSelects.map(select=>select.value);}
updateImageForm();
