export default {
  async fetch(request, env, ctx) {
    // 只处理 GET 请求
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    
    // 路由处理
    if (url.pathname === '/bash' || url.pathname === '/') {
      return await handleBashRequest(env);
    }
    
    // 支持指定单个仓库
    if (url.pathname === '/fetch') {
      return await handleCustomFetch(url, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * 处理主要的 bash 代码获取请求
 */
async function handleBashRequest(env) {
  try {
    const wikiPages = JSON.parse(env.WIKI_PAGES || '[]');
    const excludePrefixes = (env.EXCLUDE_PREFIXES || '')
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    const allBashCode = [];
    const errors = [];

    // 并行获取所有 wiki 页面
    const fetchPromises = [];
    
    for (const config of wikiPages) {
      for (const page of config.pages) {
        fetchPromises.push(
          fetchWikiPage(config.type, config.owner, config.repo, page)
            .then(content => ({ content, page: `${config.owner}/${config.repo}/${page}` }))
            .catch(err => ({ error: err.message, page: `${config.owner}/${config.repo}/${page}` }))
        );
      }
    }

    const results = await Promise.all(fetchPromises);

    for (const result of results) {
      if (result.error) {
        errors.push(`# Error fetching ${result.page}: ${result.error}`);
        continue;
      }

      const bashBlocks = extractBashBlocks(result.content);
      const filteredBlocks = filterByPrefix(bashBlocks, excludePrefixes);
      
      if (filteredBlocks.length > 0) {
        allBashCode.push(`# === Source: ${result.page} ===`);
        allBashCode.push(...filteredBlocks);
        allBashCode.push('');
      }
    }

    // 组装最终输出
    let output = '';
    
    if (errors.length > 0) {
      output += errors.join('\n') + '\n\n';
    }
    
    output += allBashCode.join('\n');

    return new Response(output, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300', // 缓存5分钟
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error) {
    return new Response(`Error: ${error.message}`, { 
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * 处理自定义获取请求
 * 示例: /fetch?type=github&owner=user&repo=repo&page=Home
 */
async function handleCustomFetch(url, env) {
  const params = url.searchParams;
  const type = params.get('type') || 'github';
  const owner = params.get('owner');
  const repo = params.get('repo');
  const page = params.get('page') || 'Home';

  if (!owner || !repo) {
    return new Response('Missing required params: owner, repo', { status: 400 });
  }

  const excludePrefixes = (env.EXCLUDE_PREFIXES || '')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  try {
    const content = await fetchWikiPage(type, owner, repo, page);
    const bashBlocks = extractBashBlocks(content);
    const filteredBlocks = filterByPrefix(bashBlocks, excludePrefixes);

    return new Response(filteredBlocks.join('\n'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

/**
 * 获取 Wiki 页面内容
 */
async function fetchWikiPage(type, owner, repo, page) {
  let rawUrl;

  if (type === 'github') {
    // GitHub Wiki Raw URL 格式
    // 方式1: 通过 wiki 仓库的 raw 地址
    rawUrl = `https://raw.githubusercontent.com/wiki/${owner}/${repo}/${page}.md`;
  } else if (type === 'gitlab') {
    // GitLab Wiki Raw URL 格式
    rawUrl = `https://gitlab.com/${owner}/${repo}/-/wikis/${page}.md`;
  } else {
    throw new Error(`Unsupported type: ${type}`);
  }

  const response = await fetch(rawUrl, {
    headers: {
      'User-Agent': 'Cloudflare-Worker-Wiki-Scraper/1.0',
      'Accept': 'text/plain',
    }
  });

  if (!response.ok) {
    // GitHub 备用方案：尝试不同的 URL 格式
    if (type === 'github') {
      const altUrl = `https://github.com/${owner}/${repo}.wiki.git/raw/master/${page}.md`;
      const altResponse = await fetch(altUrl, {
        headers: {
          'User-Agent': 'Cloudflare-Worker-Wiki-Scraper/1.0',
        }
      });
      if (altResponse.ok) {
        return await altResponse.text();
      }
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

/**
 * 提取 Markdown 中的 bash/shell 代码块
 */
function extractBashBlocks(markdown) {
  const blocks = [];
  
  // 匹配 ```bash, ```shell, ```sh 代码块
  const regex = /```(?:bash|shell|sh)\s*\n([\s\S]*?)```/gi;
  
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const code = match[1].trim();
    if (code) {
      blocks.push(code);
    }
  }

  return blocks;
}

/**
 * 过滤掉指定前缀的代码行/代码块
 */
function filterByPrefix(blocks, excludePrefixes) {
  if (excludePrefixes.length === 0) {
    return blocks;
  }

  return blocks.map(block => {
    // 按行过滤
    const lines = block.split('\n');
    const filteredLines = lines.filter(line => {
      const trimmedLine = line.trim();
      // 检查是否以任何排除前缀开头
      return !excludePrefixes.some(prefix => 
        trimmedLine.startsWith(prefix)
      );
    });
    return filteredLines.join('\n');
  }).filter(block => block.trim().length > 0); // 移除空代码块
}
