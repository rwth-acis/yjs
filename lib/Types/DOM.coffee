
json_types_uninitialized = require "./JsonTypes"

# some dom implementations may call another dom.method that simulates the behavior of another.
# For example xml.insertChild(dom) , wich inserts an element at the end, and xml.insertAfter(dom,null) wich does the same
# But Y's proxy may be called only once!
proxy_token = false
dont_proxy = (f)->
  proxy_token = true
  try
    f()
  catch e
    proxy_token = false
    throw new Error e
  proxy_token = false

_proxy = (f_name, f)->
  old_f = @[f_name]
  if old_f?
    @[f_name] = ()->
      if not proxy_token and not @_y?.isDeleted()
        that = this
        args = arguments
        dont_proxy ()->
          f.apply that, args
          old_f.apply that, args
      else
        old_f.apply this, arguments
  #else
  #  @[f_name] = f
Element?.prototype._proxy = _proxy


module.exports = (HB)->
  json_types = json_types_uninitialized HB
  types = json_types.types
  parser = json_types.parser

  #
  # Manages XML types
  # Not supported:
  # * Attribute nodes
  # * Real replace of child elements (to much overhead). Currently, the new element is inserted after the 'replaced' element, and then it is deleted.
  # * Namespaces (*NS)
  # * Browser specific methods (webkit-* operations)
  class XmlType extends types.Insert

    constructor: (uid, @tagname, attributes, elements, @xml)->
      ### In case you make this instanceof Insert again
      if prev? and (not next?) and prev.type?
        # adjust what you actually mean. you want to insert after prev, then
        # next is not defined. but we only insert after non-deleted elements.
        # This is also handled in TextInsert.
        while prev.isDeleted()
          prev = prev.prev_cl
        next = prev.next_cl
      ###

      super(uid)


      if @xml?._y?
        d = new types.Delete undefined, @xml._y
        HB.addOperation(d).execute()
        @xml._y = null

      if attributes? and elements?
        @saveOperation 'attributes', attributes
        @saveOperation 'elements', elements
      else if (not attributes?) and (not elements?)
        @attributes = new types.JsonType()
        @attributes.setMutableDefault 'immutable'
        HB.addOperation(@attributes).execute()
        @elements = new types.WordType()
        @elements.parent = @
        HB.addOperation(@elements).execute()
      else
        throw new Error "Either define attribute and elements both, or none of them"

      if @xml?
        @tagname = @xml.tagName
        for i in [0...@xml.attributes.length]
          attr = xml.attributes[i]
          @attributes.val(attr.name, attr.value)
        for n in @xml.childNodes
          if n.nodeType is n.TEXT_NODE
            word = new TextNodeType(undefined, n)
            HB.addOperation(word).execute()
            @elements.push word
          else if n.nodeType is n.ELEMENT_NODE
            element = new XmlType undefined, undefined, undefined, undefined, n
            HB.addOperation(element).execute()
            @elements.push element
          else
            throw new Error "I don't know Node-type #{n.nodeType}!!"
        @setXmlProxy()
      undefined

    #
    # Identifies this class.
    # Use it in order to check whether this is an xml-type or something else.
    #
    type: "XmlType"

    applyDelete: (op)->
      if @insert_parent? and not @insert_parent.isDeleted()
        @insert_parent.applyDelete op
      else
        @attributes.applyDelete()
        @elements.applyDelete()
        super

    cleanup: ()->
      super()

    setXmlProxy: ()->
      @xml._y = @
      that = @

      @elements.on 'insert', (event, op)->
        if op.creator isnt HB.getUserId() and this is that.elements
          newNode = op.content.val()
          right = op.next_cl
          while right? and right.isDeleted()
            right = right.next_cl
          rightNode = null
          if right.type isnt 'Delimiter'
            rightNode = right.val().val()
          dont_proxy ()->
            that.xml.insertBefore newNode, rightNode
      @elements.on 'delete', (event, op)->
        del_op = op.deleted_by[0]
        if del_op? and del_op.creator isnt HB.getUserId() and this is that.elements
          deleted = op.content.val()
          dont_proxy ()->
            that.xml.removeChild deleted

      @attributes.on ['add', 'update'], (event, property_name, op)->
        if op.creator isnt HB.getUserId() and this is that.attributes
          dont_proxy ()->
            newval = op.val().val()
            if newval?
              that.xml.setAttribute(property_name, op.val().val())
            else
              that.xml.removeAttribute(property_name)








      ## Here are all methods that proxy the behavior of the xml

      # you want to find a specific child element. Since they are carried by an Insert-Type, you want to find that Insert-Operation.
      # @param child {DomElement} Dom element.
      # @return {InsertType} This carries the XmlType that represents the DomElement (child). false if i couldn't find it.
      #
      findNode = (child)->
        if not child?
          throw new Error "you must specify a parameter!"
        child = child._y
        elem = that.elements.beginning.next_cl
        while elem.type isnt 'Delimiter' and elem.content isnt child
          elem = elem.next_cl
        if elem.type is 'Delimiter'
          false
        else
          elem

      insertBefore = (insertedNode_s, adjacentNode)->
        next = null
        if adjacentNode?
          next = findNode adjacentNode
        prev = null
        if next
          prev = next.prev_cl
        else
          prev = @_y.elements.end.prev_cl
          while prev.isDeleted()
            prev = prev.prev_cl
        inserted_nodes = null
        if insertedNode_s.nodeType is insertedNode_s.DOCUMENT_FRAGMENT_NODE
          child = insertedNode_s.lastChild
          while child?
            element = new XmlType undefined, undefined, undefined, undefined, child
            HB.addOperation(element).execute()
            that.elements.insertAfter prev, element
            child = child.previousSibling
        else
          element = new XmlType undefined, undefined, undefined, undefined, insertedNode_s
          HB.addOperation(element).execute()
          that.elements.insertAfter prev, element

      @xml._proxy 'insertBefore', insertBefore
      @xml._proxy 'appendChild', insertBefore
      @xml._proxy 'removeAttribute', (name)->
        that.attributes.val(name, undefined)
      @xml._proxy 'setAttribute', (name, value)->
        that.attributes.val name, value

      renewClassList = (newclass)->
        dont_do_it = false
        if newclass?
          for elem in this
            if newclass is elem
              dont_do_it = true
        value = Array.prototype.join.call this, " "
        if newclass? and not dont_do_it
          value += " "+newclass
        that.attributes.val('class', value )
      _proxy.call @xml.classList, 'add', renewClassList
      _proxy.call @xml.classList, 'remove', renewClassList
      @xml.__defineSetter__ 'className', (val)->
        @setAttribute('class', val)
      @xml.__defineGetter__ 'className', ()->
        that.attributes.val('class')
      @xml.__defineSetter__ 'textContent', (val)->
        # remove all nodes
        elem = that.xml.firstChild
        while elem?
          remove = elem
          elem = elem.nextSibling
          that.xml.removeChild remove

        # insert word content
        if val isnt ""
          text_node = document.createTextNode val
          that.xml.appendChild text_node

      removeChild = (node)->
        elem = findNode node
        if not elem
          throw new Error "You are only allowed to delete existing (direct) child elements!"
        d = new types.Delete undefined, elem
        HB.addOperation(d).execute()
        node._y = null
      @xml._proxy 'removeChild', removeChild
      @xml._proxy 'replaceChild', (insertedNode, replacedNode)->
        insertBefore.call this, insertedNode, replacedNode
        removeChild.call this, replacedNode



    val: (enforce = false)->
      if document?
        if (not @xml?) or enforce
          @xml = document.createElement @tagname

          attr = @attributes.val()
          for attr_name, value of attr
            if value?
              a = document.createAttribute attr_name
              a.value = value
              @xml.setAttributeNode a

          e = @elements.beginning.next_cl
          while e.type isnt "Delimiter"
            n = e.content
            if not e.isDeleted() and e.content? # TODO: how can this happen?  Probably because listeners
              if n.type is "XmlType"
                @xml.appendChild n.val(enforce)
              else if n.type is "TextNodeType"
                text_node = n.val()
                @xml.appendChild text_node
              else
                throw new Error "Internal structure cannot be transformed to dom"
            e = e.next_cl
        @setXmlProxy()
        @xml


    execute: ()->
      super()
    ###
      if not @validateSavedOperations()
        return false
      else

        return true
    ###

    #
    # Get the parent of this JsonType.
    # @return {XmlType}
    #
    getParent: ()->
      @parent

    #
    # @private
    #
    # Convert all relevant information of this operation to the json-format.
    # This result can be send to other clients.
    #
    _encode: ()->
      json =
        {
          'type' : @type
          'attributes' : @attributes.getUid()
          'elements' : @elements.getUid()
          'tagname' : @tagname
          'uid' : @getUid()
        }
      json

  parser['XmlType'] = (json)->
    {
      'uid' : uid
      'attributes' : attributes
      'elements' : elements
      'tagname' : tagname
    } = json

    new XmlType uid, tagname, attributes, elements, undefined

#
  # @nodoc
  # Defines an object that is cannot be changed. You can use this to set an immutable string, or a number.
  #
  class TextNodeType extends types.ImmutableObject

    #
    # @param {Object} uid A unique identifier. If uid is undefined, a new uid will be created.
    # @param {Object} content
    #
    constructor: (uid, content)->
      if content._y?
        d = new types.Delete undefined, content._y
        HB.addOperation(d).execute()
        content._y = null
      content._y = @
      super uid, content

    applyDelete: (op)->
      if @insert_parent? and not @insert_parent.isDeleted()
        @insert_parent.applyDelete op
      else
        super


    type: "TextNodeType"

    #
    # Encode this operation in such a way that it can be parsed by remote peers.
    #
    _encode: ()->
      json = {
        'type': @type
        'uid' : @getUid()
        'content' : @content.textContent
      }
      json

  parser['TextNodeType'] = (json)->
    {
      'uid' : uid
      'content' : content
    } = json
    textnode = document.createTextNode content
    new TextNodeType uid, textnode

  types['XmlType'] = XmlType

  json_types