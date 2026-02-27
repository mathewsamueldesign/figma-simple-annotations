figma.showUI(__html__, { width: 280, height: 540 });

function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : { r: 1, g: 0, b: 0 };
}

// Returns white text wherever it achieves WCAG 2.1 AA 3:1 contrast (large/bold text standard);
// falls back to black otherwise. Badge labels at 13px Bold qualify as large text.
function getContrastTextColor(hex: string): RGB {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  // White text passes 3:1 when bg luminance <= 0.30
  return L <= 0.30 ? { r: 1, g: 1, b: 1 } : { r: 0, g: 0, b: 0 };
}

interface AnnotationItem {
  id: string;
  title: string;
  desc: string;
  color: string;
}

interface AnnotationData {
  theme?: string;
  matchStroke?: boolean;
  connectorColor: string;
  items: AnnotationItem[];
  targetNodeId?: string;
}

const FONT_REGULAR: FontName = { family: "Inter", style: "Regular" };
const FONT_BOLD: FontName = { family: "Inter", style: "Bold" };

function getTopLevelFrame(node: BaseNode): BaseNode {
  let topParent: BaseNode = node;
  let currentParent: BaseNode | null = node;
  while (currentParent && currentParent.type !== 'PAGE') {
    if (currentParent.type === 'FRAME' || currentParent.type === 'COMPONENT' || currentParent.type === 'COMPONENT_SET') {
      topParent = currentParent;
    }
    currentParent = currentParent.parent;
  }
  return topParent;
}

// Fetch tags: clientStorage (personal) vs scanning the current page (document)
async function getTagsData() {
  const clientTagsStr = await figma.clientStorage.getAsync('savedTags');
  const clientTags: { title: string, color: string }[] = clientTagsStr ? JSON.parse(clientTagsStr) : [];

  const docMap = new Map<string, { title: string, color: string }>();

  // Extract from existing document annotations
  const annotationFrames = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } });
  for (const frame of annotationFrames) {
    const dataStr = frame.getPluginData('annotationData');
    if (dataStr) {
      try {
        const data = JSON.parse(dataStr) as AnnotationData;
        if (data.items) {
          for (const item of data.items) {
            if (item.title && item.title.trim()) {
              const title = item.title.trim();
              docMap.set(title.toLowerCase(), { title, color: item.color });
            }
          }
        }
      } catch (e) { console.error('Failed to parse annotation data for tag scan', e); }
    }
  }

  const documentTags = Array.from(docMap.values());
  return { clientTags, documentTags };
}

async function emitState() {
  const selection = figma.currentPage.selection;
  const { clientTags, documentTags } = await getTagsData();

  if (selection.length === 1) {
    let node = selection[0];

    // If user selects the wrapping group, dig inside to find the annotation frame
    if (node.type === 'GROUP') {
      const frames = node.findChildren(n => n.type === 'FRAME' && !!n.getPluginData('annotationData'));
      if (frames.length > 0) {
        node = frames[0] as SceneNode;
      }
    }

    // If the node itself isn't an annotation, walk up the parent chain to find one
    // Also detect which Item Row the selection is inside, for scroll-to focus
    let focusItemId: string | null = null;
    if (!node.getPluginData('annotationData')) {
      let cursor: BaseNode | null = selection[0];
      while (cursor && cursor.type !== 'PAGE') {
        if ('getPluginData' in cursor) {
          const asFrame = cursor as FrameNode;
          if (cursor.name === 'Item Row' && !focusItemId) {
            focusItemId = asFrame.getPluginData('itemId') || null;
          }
          if (cursor.type === 'FRAME' && asFrame.getPluginData('annotationData')) {
            node = cursor as SceneNode;
            break;
          }
        }
        cursor = cursor.parent;
      }
    }

    const dataString = node.getPluginData('annotationData');
    if (dataString) {
      try {
        const data = JSON.parse(dataString);
        figma.ui.postMessage({ type: 'set-state', mode: 'edit', data, clientTags, documentTags, focusItemId });
        return;
      } catch (e) {
        console.error("Failed to parse annotation data", e);
      }
    }
  }

  // If no single annotation is selected, default to create mode
  figma.ui.postMessage({ type: 'set-state', mode: 'create', clientTags, documentTags });
}

// Guard to suppress selectionchange events during annotation rebuild
// (removing/re-adding children causes spurious empty-selection events)
let isBuildingAnnotation = false;

// Check selection and update UI state
figma.on('selectionchange', () => {
  if (isBuildingAnnotation) return;
  emitState();
});

// Trigger initial state on plugin launch
emitState();

// Auto-update connectors when moving things
// Figma requires loadAllPagesAsync before registering documentchange
(async () => {
  await figma.loadAllPagesAsync();
  figma.on('documentchange', (event) => {
    let needsUpdate = false;
    for (const change of event.documentChanges) {
      if (change.type === 'PROPERTY_CHANGE' && change.properties) {
        const p = change.properties;
        if (p.indexOf('x') !== -1 || p.indexOf('y') !== -1 || p.indexOf('width') !== -1 || p.indexOf('height') !== -1) {
          needsUpdate = true;
        }

        // Handle Manual Text Edits mapping back to Plugin Data
        if (p.indexOf('characters') !== -1 && change.node.type === 'TEXT') {
          const textNode = change.node as TextNode;
          if (textNode.name === 'Title' || textNode.name === 'Description') {
            // Traverse up to find the Annotation Note
            let parent = textNode.parent;
            let itemRow = null;
            let annotationFrame = null;

            while (parent && parent.type !== 'PAGE') {
              if (parent.name === 'Item Row') itemRow = parent;
              if (parent.type === 'FRAME' && parent.getPluginData('annotationData')) {
                annotationFrame = parent as FrameNode;
                break;
              }
              parent = parent.parent;
            }

            if (annotationFrame && itemRow) {
              const dataStr = annotationFrame.getPluginData('annotationData');
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr) as AnnotationData;

                  const itemId = itemRow.getPluginData('itemId');
                  let targetItem = data.items.find(i => i.id === itemId);

                  // Fallback for legacy annotations
                  if (!targetItem) {
                    const rowChildren = annotationFrame.children.filter(c => c.name === 'Item Row');
                    const itemIndex = rowChildren.findIndex(r => r.id === itemRow!.id);
                    if (itemIndex > -1 && data.items[itemIndex]) {
                      targetItem = data.items[itemIndex];
                    }
                  }

                  if (targetItem) {
                    if (textNode.name === 'Title') {
                      targetItem.title = textNode.characters;
                    } else if (textNode.name === 'Description') {
                      targetItem.desc = textNode.characters;
                    }

                    // Save and re-sync
                    annotationFrame.setPluginData('annotationData', JSON.stringify(data));

                    // If this frame is currently selected, update the full UI state
                    const selection = figma.currentPage.selection;
                    if (selection.length === 1 && selection[0].id === annotationFrame.id) {
                      emitState(); // emitState is async and includes clientTags + documentTags
                    }
                  }
                } catch (e) { console.error('Failed to sync text change to plugin data', e); }
              }
            }
          }
        }
      }
    }
    if (needsUpdate) {
      const annotationFrames = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } });
      for (const frame of annotationFrames) {
        if (frame.type === 'FRAME') {
          const dataStr = frame.getPluginData('annotationData');
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (data.targetNodeId) {
                updateConnector(frame as FrameNode, data);
              }
            } catch (e) { console.error('Failed to update connector after document change', e); }
          }
        }
      }
    }
  });
})();

async function updateConnector(frame: FrameNode, data: AnnotationData) {
  try {
    if (!data.targetNodeId) return;
    const targetNode = await figma.getNodeByIdAsync(data.targetNodeId) as SceneNode;

    const lineId = frame.getPluginData('connectorLineId');
    const dotId = frame.getPluginData('connectorDotId');
    let line = lineId ? await figma.getNodeByIdAsync(lineId) as VectorNode : null;
    let dot = dotId ? await figma.getNodeByIdAsync(dotId) as EllipseNode : null;

    if (!targetNode) {
      if (line) line.visible = false;
      if (dot) dot.visible = false;
      return;
    }
    if (line) line.visible = true;
    if (dot) dot.visible = true;

    // Destroy stray ConnectorNode if we previously generated one by accident
    if (line && (line as any).type === 'CONNECTOR') { line.remove(); line = null; }
    if (dot && (dot as any).type === 'CONNECTOR') { dot.remove(); dot = null; }

    const targetBounds = targetNode.absoluteBoundingBox;
    const frameBounds = frame.absoluteBoundingBox;
    if (!targetBounds || !frameBounds) return;

    const tCenterX = targetBounds.x + targetBounds.width / 2;
    const tCenterY = targetBounds.y + targetBounds.height / 2;
    const fCenterX = frameBounds.x + frameBounds.width / 2;
    const fCenterY = frameBounds.y + frameBounds.height / 2;

    let startX = 0, startY = 0, endX = 0, endY = 0;
    let isHorizontal = Math.abs(tCenterX - fCenterX) > Math.abs(tCenterY - fCenterY);

    const SNAP_THRESHOLD = 16;
    let isSnapped = false;

    if (isHorizontal) {
      isSnapped = Math.abs(tCenterY - fCenterY) < SNAP_THRESHOLD;
      const finalY = isSnapped ? tCenterY : fCenterY;

      if (fCenterX > tCenterX) {
        // Frame is to the right
        startX = frameBounds.x;
        startY = finalY;
        endX = targetBounds.x + targetBounds.width;
        endY = tCenterY;
      } else {
        // Frame is to the left
        startX = frameBounds.x + frameBounds.width;
        startY = finalY;
        endX = targetBounds.x;
        endY = tCenterY;
      }
    } else {
      isSnapped = Math.abs(tCenterX - fCenterX) < SNAP_THRESHOLD;
      const finalX = isSnapped ? tCenterX : fCenterX;

      if (fCenterY > tCenterY) {
        // Frame is below
        startX = finalX;
        startY = frameBounds.y;
        endX = tCenterX;
        endY = targetBounds.y + targetBounds.height;
      } else {
        // Frame is above
        startX = finalX;
        startY = frameBounds.y + frameBounds.height;
        endX = tCenterX;
        endY = targetBounds.y;
      }
    }

    // Convert absolute coordinates into local coordinates relative to the frame
    const lStartX = startX - frameBounds.x;
    const lStartY = startY - frameBounds.y;
    const lEndX = endX - frameBounds.x;
    const lEndY = endY - frameBounds.y;

    const minX = Math.min(lStartX, lEndX);
    const minY = Math.min(lStartY, lEndY);
    const pStartX = lStartX - minX;
    const pStartY = lStartY - minY;
    const pEndX = lEndX - minX;
    const pEndY = lEndY - minY;

    // We want the 'bus' elbows to run completely outside the parent container (e.g. the main artboard)
    let topParent = getTopLevelFrame(targetNode);
    const parentBounds = 'absoluteBoundingBox' in topParent ? topParent.absoluteBoundingBox : null;

    const allFrames = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } });

    let pathData;
    if (isSnapped) {
      pathData = `M ${pStartX} ${pStartY} L ${pEndX} ${pEndY}`;
    } else if (isHorizontal) {
      allFrames.sort((a, b) => a.y - b.y);
      const frameIndex = allFrames.findIndex(f => f.id === frame.id);

      const invertedIndex = Math.max(0, allFrames.length - 1 - frameIndex);
      const staggerOffset = invertedIndex * 12;

      let midX;
      if (pEndX < pStartX) {
        // Annotation is right of button. Route bus to the right of the parent frame
        const parentRightX = parentBounds ? parentBounds.x + parentBounds.width : targetBounds.x + targetBounds.width;
        // Convert the absolute parent edge to local coords for our SVG
        const localParentRightX = parentRightX - frameBounds.x - minX;
        midX = localParentRightX + 24 + staggerOffset;
      } else {
        // Annotation is left of button. Route bus to the left of the parent frame
        const parentLeftX = parentBounds ? parentBounds.x : targetBounds.x;
        const localParentLeftX = parentLeftX - frameBounds.x - minX;
        midX = localParentLeftX - 24 - staggerOffset;
      }

      pathData = `M ${pStartX} ${pStartY} L ${midX} ${pStartY} L ${midX} ${pEndY} L ${pEndX} ${pEndY}`;
    } else {
      allFrames.sort((a, b) => a.x - b.x);
      const frameIndex = allFrames.findIndex(f => f.id === frame.id);

      const invertedIndex = Math.max(0, allFrames.length - 1 - frameIndex);
      const staggerOffset = invertedIndex * 12;

      let midY;
      if (pEndY < pStartY) {
        // Annotation is below the button. Route the bus below the parent frame.
        const parentBottomY = parentBounds ? parentBounds.y + parentBounds.height : targetBounds.y + targetBounds.height;
        const localParentBottomY = parentBottomY - frameBounds.y - minY;
        midY = localParentBottomY + 24 + staggerOffset;
      } else {
        // Annotation is above the button. Route the bus above the parent frame
        const parentTopY = parentBounds ? parentBounds.y : targetBounds.y;
        const localParentTopY = parentTopY - frameBounds.y - minY;
        midY = localParentTopY - 24 - staggerOffset;
      }

      pathData = `M ${pStartX} ${pStartY} L ${pStartX} ${midY} L ${pEndX} ${midY} L ${pEndX} ${pEndY}`;
    }

    if (!line || line.type !== 'VECTOR') {
      line = figma.createVector();
      line.name = "↳ Connector Line";
      frame.appendChild(line);
      line.layoutPositioning = "ABSOLUTE";
      frame.setPluginData('connectorLineId', line.id);
    }

    if (line.vectorPaths.length === 0 || line.vectorPaths[0].data !== pathData) {
      line.vectorPaths = [{ windingRule: 'EVENODD', data: pathData }];
    }
    if (line.x !== minX) line.x = minX;
    if (line.y !== minY) line.y = minY;
    line.strokeWeight = 2;
    line.dashPattern = [4, 4];
    line.cornerRadius = 8;
    line.strokes = [{ type: 'SOLID', color: hexToRgb(data.connectorColor) }];
    line.fills = [];

    if (!dot || dot.type !== 'ELLIPSE') {
      dot = figma.createEllipse();
      dot.name = "Connector End";
      dot.resize(10, 10);
      frame.appendChild(dot);
      dot.layoutPositioning = "ABSOLUTE";
      frame.setPluginData('connectorDotId', dot.id);
    }

    const dotX = lEndX - dot.width / 2;
    const dotY = lEndY - dot.height / 2;

    if (dot.x !== dotX) dot.x = dotX;
    if (dot.y !== dotY) dot.y = dotY;
    dot.fills = [{ type: 'SOLID', color: hexToRgb(data.connectorColor) }];
    dot.strokes = [];
    dot.strokeWeight = 0;

    // Send lines to the back of the frame, behind the actual annotation rows
    if (line.parent === frame) frame.insertChild(0, line);
    if (dot.parent === frame) frame.insertChild(1, dot);

  } catch (err) {
    figma.notify("Connector Drawing Error: " + (err as Error).message);
    console.error(err);
  }
}

async function buildAnnotationContent(parentFrame: FrameNode, data: AnnotationData) {
  // Clear existing children (for edit mode) except for the connector line and dot
  parentFrame.children.forEach(c => {
    if (c.name !== '↳ Connector Line' && c.name !== 'Connector End') {
      c.remove();
    }
  });

  await figma.loadFontAsync(FONT_REGULAR);
  await figma.loadFontAsync(FONT_BOLD);

  // Group container styling 
  const isLight = data.theme === 'light';

  parentFrame.clipsContent = false;
  parentFrame.layoutMode = "VERTICAL";
  parentFrame.paddingTop = 16;
  parentFrame.paddingBottom = 16;
  parentFrame.paddingLeft = 16;
  parentFrame.paddingRight = 16;
  parentFrame.itemSpacing = 16;
  parentFrame.cornerRadius = 16;
  parentFrame.fills = [{ type: 'SOLID', color: hexToRgb(isLight ? '#FFFFFF' : '#1C1C1E') }];

  if (data.matchStroke) {
    parentFrame.strokes = [{ type: 'SOLID', color: hexToRgb(data.connectorColor) }];
  } else {
    parentFrame.strokes = [{ type: 'SOLID', color: hexToRgb(isLight ? '#E5E5E5' : '#333333') }];
  }

  parentFrame.strokeWeight = 1;
  parentFrame.primaryAxisSizingMode = "AUTO";
  parentFrame.counterAxisSizingMode = "FIXED";
  parentFrame.layoutAlign = "MIN";
  parentFrame.resize(300, parentFrame.height);

  for (const item of data.items) {
    if (!item.title?.trim() && !item.desc?.trim()) continue;

    const itemRow = figma.createFrame();
    itemRow.name = "Item Row";
    itemRow.setPluginData('itemId', item.id);
    itemRow.layoutMode = "VERTICAL";
    itemRow.itemSpacing = 8;
    itemRow.fills = [];
    itemRow.primaryAxisSizingMode = "AUTO";
    itemRow.counterAxisSizingMode = "FIXED";
    itemRow.layoutAlign = "STRETCH";

    if (item.title) {
      const badge = figma.createFrame();
      badge.name = "Title Badge";
      badge.layoutMode = "HORIZONTAL";
      badge.layoutAlign = "MIN";
      badge.paddingTop = 4;
      badge.paddingBottom = 4;
      badge.paddingLeft = 12;
      badge.paddingRight = 12;
      badge.cornerRadius = 100;
      badge.fills = [{ type: 'SOLID', color: hexToRgb(item.color) }];

      const titleText = figma.createText();
      titleText.name = "Title";
      titleText.characters = item.title;
      titleText.fontName = FONT_BOLD;
      titleText.fontSize = 13;
      titleText.fills = [{ type: 'SOLID', color: getContrastTextColor(item.color) }];

      badge.appendChild(titleText);
      badge.primaryAxisSizingMode = "AUTO";
      badge.counterAxisSizingMode = "AUTO";
      itemRow.appendChild(badge);
    }

    if (item.desc) {
      const descText = figma.createText();
      descText.name = "Description";
      descText.characters = item.desc;
      descText.fontName = FONT_REGULAR;
      descText.fontSize = 14;
      descText.lineHeight = { value: 22, unit: 'PIXELS' };
      descText.fills = [{ type: 'SOLID', color: hexToRgb(isLight ? '#444444' : '#E0E0E0') }];
      descText.layoutAlign = "STRETCH";
      descText.textAutoResize = "HEIGHT";
      itemRow.appendChild(descText);
    }

    parentFrame.appendChild(itemRow);
  }
}

figma.ui.onmessage = async (msg: { type: string, data?: any, message?: string }) => {
  if (msg.type === 'notify' && msg.message) {
    figma.notify(msg.message);
    return;
  }

  if (msg.type === 'close-plugin') {
    figma.closePlugin();
    return;
  }

  if (msg.type === 'save-tags' && msg.data) {
    await figma.clientStorage.setAsync('savedTags', JSON.stringify(msg.data));
    return;
  }

  if (msg.type === 'create-annotation' && msg.data) {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Please select exactly one element to point the annotation to.");
      return;
    }

    const targetNode = selection[0];
    const frame = figma.createFrame();
    frame.name = targetNode.name;

    await buildAnnotationContent(frame, msg.data);

    // Save data state
    const payload = { ...msg.data, targetNodeId: targetNode.id };
    frame.setPluginData('annotationData', JSON.stringify(payload));

    // Positioning Logic
    let topParent = getTopLevelFrame(targetNode);
    const targetBounds = targetNode.absoluteBoundingBox;
    const parentBounds = 'absoluteBoundingBox' in topParent ? topParent.absoluteBoundingBox : null;

    let targetX = 0;
    let targetY = 0;

    if (targetBounds && parentBounds) {
      targetX = parentBounds.x + parentBounds.width + 120;
      targetY = targetBounds.y;
    } else if (targetBounds) {
      targetX = targetBounds.x + 120;
      targetY = targetBounds.y;
    } else {
      targetX = targetNode.x + 120;
      targetY = targetNode.y;
    }

    // Collision detection: shift down if overlapping with existing annotations
    const existingAnnotations = figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['annotationData'] } }).filter(n => n.id !== frame.id);
    let isOverlapping = true;
    let safetyGuard = 0;
    while (isOverlapping && safetyGuard < 100) {
      safetyGuard++;
      isOverlapping = false;
      for (const existing of existingAnnotations) {
        if ('absoluteBoundingBox' in existing && existing.absoluteBoundingBox) {
          const ez = existing.absoluteBoundingBox;
          const fz = { x: targetX, y: targetY, width: frame.width, height: frame.height };

          if (
            fz.x < ez.x + ez.width + 20 &&
            fz.x + fz.width + 20 > ez.x &&
            fz.y < ez.y + ez.height + 20 &&
            fz.y + fz.height + 20 > ez.y
          ) {
            isOverlapping = true;
            targetY += ez.height + 24; // Shift down by the height of the colliding annotation plus gap
            break;
          }
        }
      }
    }

    const sectionParent = topParent.parent?.type === 'SECTION' ? topParent.parent : null;
    if (sectionParent) {
      (sectionParent as SectionNode).appendChild(frame);
      const sBounds = ('absoluteBoundingBox' in sectionParent && sectionParent.absoluteBoundingBox) ? sectionParent.absoluteBoundingBox : { x: 0, y: 0 };
      frame.x = targetX - sBounds.x;
      frame.y = targetY - sBounds.y;
    } else {
      figma.currentPage.appendChild(frame);
      frame.x = targetX;
      frame.y = targetY;
    }
    updateConnector(frame, payload);

    figma.currentPage.selection = [frame];
  }

  if (msg.type === 'update-annotation' && msg.data) {
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) {
      figma.notify("Lost selection. Please re-select the annotation.");
      return;
    }

    // Walk up the parent chain to find the annotation frame,
    // allowing edits when a child element is selected (e.g. a badge or text node)
    let node: BaseNode = selection[0];
    while (node && node.type !== 'PAGE') {
      if (node.type === 'FRAME' && (node as FrameNode).getPluginData('annotationData')) break;
      node = node.parent as BaseNode;
    }
    const frame = node as FrameNode;
    if (!frame || frame.type !== 'FRAME' || !frame.getPluginData('annotationData')) {
      figma.notify("Selected node is not an editable annotation.");
      return;
    }

    // Retain original targetNodeId
    const existingDataStr = frame.getPluginData('annotationData');
    if (existingDataStr) {
      try {
        const existingData = JSON.parse(existingDataStr);
        if (existingData.targetNodeId) {
          msg.data.targetNodeId = existingData.targetNodeId;
        }
      } catch (e) { console.error('Failed to parse existing annotation data during update', e); }
    }

    isBuildingAnnotation = true;
    await buildAnnotationContent(frame, msg.data);
    frame.setPluginData('annotationData', JSON.stringify(msg.data));
    updateConnector(frame as FrameNode, msg.data);
    // Restore selection to the annotation frame (child nodes were destroyed during rebuild)
    figma.currentPage.selection = [frame];
    isBuildingAnnotation = false;
    // Manually emit state once with the correct selection
    emitState();
  }
};
