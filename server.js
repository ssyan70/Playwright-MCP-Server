// Replace the switch cases in BOTH the CallToolRequestSchema handler AND handleToolsCall function

// In the CallToolRequestSchema handler:
case 'extract_mls_community_fast':
  const fastResult1 = await extractMLSCommunityFast(currentPage, args.address);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(fastResult1, null, 2)
      }
    ]
  };

case 'extract_mls_community':
  const mlsResult = await extractMLSCommunity(currentPage, args.address);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(mlsResult, null, 2)
      }
    ]
  };

// In the handleToolsCall function:
case 'extract_mls_community_fast':
  const fastResult2 = await extractMLSCommunityFast(currentPage, args.address);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(fastResult2, null, 2)
      }
    ]
  };

case 'extract_mls_community':
  const mlsResult2 = await extractMLSCommunity(currentPage, args.address);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(mlsResult2, null, 2)
      }
    ]
  };
