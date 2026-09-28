// F-01 回归：@aws-sdk/xml-builder 的 browser 构建依赖 DOMParser（workerd/Node 均无），
// alias 后 parseXML 走 vendored 纯 JS 实现。本测试经 **包说明符** 导入（与 SDK 内部导入
// 同路径），断言 alias 生效且解析行为与官方 node 构建一致。
import { describe, it, expect } from 'vitest';
import { parseXML, XmlNode, XmlText } from '@aws-sdk/xml-builder';

describe('aws-xml-builder shim（alias 生效）', () => {
  it('解析 CreateMultipartUploadResult（S3 分片会话创建的真实响应形态）', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>picumet</Bucket>
  <Key>isos/wepe.iso</Key>
  <UploadId>abc123</UploadId>
</CreateMultipartUploadResult>`;
    const parsed = parseXML(xml) as {
      CreateMultipartUploadResult: { Bucket: string; Key: string; UploadId: string };
    };
    expect(parsed.CreateMultipartUploadResult.Bucket).toBe('picumet');
    expect(parsed.CreateMultipartUploadResult.UploadId).toBe('abc123');
  });

  it('解析 CopyObjectResult / ListPartsResult（重复标签成数组、实体解码）', () => {
    const copy = parseXML(`<CopyObjectResult><ETag>"9b2cf535f27731c974343645a3985328"</ETag><LastModified>2026-09-26T12:00:00.000Z</LastModified></CopyObjectResult>`) as {
      CopyObjectResult: { ETag: string };
    };
    expect(copy.CopyObjectResult.ETag).toBe('"9b2cf535f27731c974343645a3985328"');

    const parts = parseXML(`<ListPartsResult><Part><PartNumber>1</PartNumber></Part><Part><PartNumber>2</PartNumber></Part></ListPartsResult>`) as {
      ListPartsResult: { Part: Array<{ PartNumber: string }> };
    };
    expect(Array.isArray(parts.ListPartsResult.Part)).toBe(true);
    expect(parts.ListPartsResult.Part.length).toBe(2);

    const entity = parseXML(`<Root><Key>a&amp;b&lt;c</Key></Root>`) as { Root: { Key: string } };
    expect(entity.Root.Key).toBe('a&b<c');
  });

  it('序列化侧：XmlNode/XmlText 输出与官方语义一致', () => {
    const node = XmlNode.of('Root').a('xmlns', 'http://s3.amazonaws.com/doc/2006-03-01/');
    node.c(XmlNode.of('Bucket', 'picumet&co'));
    expect(node.toString()).toBe('<Root xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>picumet&amp;co</Bucket></Root>');
    expect(new XmlText('x<y>').toString()).toBe('x&lt;y&gt;');
  });

  it('不依赖 DOMParser：globalThis 缺失时同样可解析', () => {
    const had = 'DOMParser' in globalThis;
    expect(had).toBe(false); // 测试环境（node）本就没有；若未来有人 polyfill 也不影响
    expect(() => parseXML('<Broken><Unclosed>')).toThrow();
  });
});
